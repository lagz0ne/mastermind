import { BusError, type StoreEntry } from "@mastermind/bus";
import type { Kv } from "./service.ts";

/**
 * In-memory {@link Kv} with the same compare-and-set rules as a JetStream KV
 * bucket. Every call yields to the event loop first, so concurrent callers
 * interleave the way they do against a real server. For tests and local runs
 * without NATS. No TTL.
 */
export class MemoryKv<T> implements Kv<T> {
	private readonly entries = new Map<string, { value: T; revision: number }>();
	private seq = 0;

	async get(key: string): Promise<StoreEntry<T> | null> {
		await tick();
		const e = this.entries.get(key);
		return e
			? { key, value: structuredClone(e.value), revision: e.revision }
			: null;
	}

	async create(key: string, value: T): Promise<number> {
		await tick();
		if (this.entries.has(key)) throw new BusError("conflict", `${key} exists`);
		return this.write(key, value);
	}

	async update(key: string, value: T, revision: number): Promise<number> {
		await tick();
		if (this.entries.get(key)?.revision !== revision)
			throw new BusError("conflict", `${key} is not at revision ${revision}`);
		return this.write(key, value);
	}

	async put(key: string, value: T): Promise<number> {
		await tick();
		return this.write(key, value);
	}

	async delete(key: string, revision?: number): Promise<void> {
		await tick();
		const e = this.entries.get(key);
		if (revision !== undefined && e?.revision !== revision)
			throw new BusError("conflict", `${key} is not at revision ${revision}`);
		this.entries.delete(key);
	}

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

	async list(filter?: string): Promise<string[]> {
		await tick();
		const keys = [...this.entries.keys()];
		if (!filter) return keys;
		const re = new RegExp(
			`^${filter
				.split(".")
				.map((t) =>
					t === "*" ? "[^.]+" : t === ">" ? ".+" : t.replace(/[^\w-]/g, "\\$&"),
				)
				.join("\\.")}$`,
		);
		return keys.filter((k) => re.test(k));
	}

	private write(key: string, value: T): number {
		this.seq += 1;
		this.entries.set(key, {
			value: structuredClone(value),
			revision: this.seq,
		});
		return this.seq;
	}
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
