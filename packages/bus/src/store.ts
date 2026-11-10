import { type KV, type KvEntry, Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import { BusError, decode, encode } from "./codec.ts";

export type StoreOptions = {
	/** Every key expires this many ms after its last write. 0 or absent: never. */
	ttlMs?: number;
	/** Revisions kept per key. Default 1. */
	history?: number;
};

export type StoreEntry<T> = { key: string; value: T; revision: number };

export type StoreEvent<T> =
	| { op: "put"; key: string; revision: number; value: T }
	| { op: "delete"; key: string; revision: number };

export type StoreWatch<T> = AsyncIterable<StoreEvent<T>> & { stop(): void };

/** JetStream reports a failed compare-and-set as "wrong last sequence" (10071). */
function isWrongLastSequence(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: unknown }).code;
	return code === 10071 || /wrong last sequence/i.test(err.message);
}

const live = (e: KvEntry | null): e is KvEntry =>
	e !== null && e.operation === "PUT";

/**
 * Typed JSON values in one JetStream KV bucket: Mastermind's own state
 * (accounts, service accounts, tokens, sessions, runners, rules). Lost races raise
 * BusError("conflict"); readers see deleted keys as absent.
 */
export class Store<T> {
	private constructor(
		readonly bucket: string,
		private readonly kv: KV,
	) {}

	/** Create the bucket, or bind to it when it already exists with the same settings. */
	static async open<T>(
		nc: NatsConnection,
		bucket: string,
		opts: StoreOptions = {},
	): Promise<Store<T>> {
		const kv = await new Kvm(nc).create(bucket, {
			history: opts.history ?? 1,
			...(opts.ttlMs ? { ttl: opts.ttlMs } : {}),
		});
		return new Store<T>(bucket, kv);
	}

	async get(key: string): Promise<StoreEntry<T> | null> {
		const e = await this.kv.get(key);
		return live(e)
			? { key, value: decode<T>(e.value), revision: e.revision }
			: null;
	}

	/** Write a new key. Throws BusError("conflict") when the key exists. Returns the revision. */
	async create(key: string, value: T): Promise<number> {
		try {
			return await this.kv.create(key, encode(value));
		} catch (err) {
			if (isWrongLastSequence(err))
				throw new BusError("conflict", `${this.bucket}/${key} exists`, {
					cause: err,
				});
			throw err;
		}
	}

	/** Compare-and-set: write only if the key is still at `revision`. Returns the new revision. */
	async update(key: string, value: T, revision: number): Promise<number> {
		try {
			return await this.kv.update(key, encode(value), revision);
		} catch (err) {
			if (isWrongLastSequence(err)) {
				throw new BusError(
					"conflict",
					`${this.bucket}/${key} is not at revision ${revision}`,
					{ cause: err },
				);
			}
			throw err;
		}
	}

	/** Write unconditionally. Returns the revision. */
	async put(key: string, value: T): Promise<number> {
		return this.kv.put(key, encode(value));
	}

	/** Delete; with `revision`, only if the key is still at it (else BusError("conflict")). */
	async delete(key: string, revision?: number): Promise<void> {
		try {
			await this.kv.delete(
				key,
				revision === undefined ? undefined : { previousSeq: revision },
			);
		} catch (err) {
			if (isWrongLastSequence(err)) {
				throw new BusError(
					"conflict",
					`${this.bucket}/${key} is not at revision ${revision}`,
					{ cause: err },
				);
			}
			throw err;
		}
	}

	/**
	 * Read and delete in one atomic step: of many concurrent callers, exactly
	 * one gets the value; the rest get null. Use for single-use tokens.
	 */
	async consume(key: string): Promise<T | null> {
		const e = await this.get(key);
		if (!e) return null;
		try {
			await this.delete(key, e.revision);
			return e.value;
		} catch (err) {
			if (err instanceof BusError && err.code === "conflict") return null;
			throw err;
		}
	}

	/** Live keys, optionally filtered by a subject-style pattern (`runner.alice.*`). */
	async list(filter?: string): Promise<string[]> {
		const keys: string[] = [];
		for await (const k of await this.kv.keys(filter)) keys.push(k);
		return keys;
	}

	/**
	 * Current values first, then every change as it happens. Pass `key` (patterns
	 * allowed) to watch part of the bucket. Call `stop()` to end the iteration.
	 */
	async watch(key?: string): Promise<StoreWatch<T>> {
		const it = await this.kv.watch(key === undefined ? {} : { key });
		async function* events(): AsyncGenerator<StoreEvent<T>> {
			for await (const e of it) {
				if (e.operation === "PUT") {
					yield {
						op: "put",
						key: e.key,
						revision: e.revision,
						value: decode<T>(e.value),
					};
				} else {
					yield { op: "delete", key: e.key, revision: e.revision };
				}
			}
		}
		const gen = events();
		return {
			[Symbol.asyncIterator]: () => gen,
			stop: () => it.stop(),
		};
	}
}
