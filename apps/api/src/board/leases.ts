// Live leases for the board. A heartbeat renews a lease in bd's leases table
// but writes no journal event, so the journal alone shows a held bead as
// expired after one lease term. ONE poller (while someone listens) reads the
// leases table and tells listeners which leases changed.
import type { Lease } from "@mastermind/core";

/** A lease change; `lease` is absent when the bead holds none any more. */
export type LeaseChange = { beadId: string; lease?: Lease };

export type LeaseSource = {
	/** Every lease that bd holds now. */
	leases(): Promise<{ beadId: string; lease: Lease }[]>;
};

export type LeaseListener = (change: LeaseChange) => void;

export class LeaseWatch {
	readonly #source: LeaseSource;
	readonly #intervalMs: number;
	readonly #onError?: (error: unknown) => void;
	readonly #listeners = new Set<LeaseListener>();
	/** beadId -> heartbeatAt|expiresAt as last seen; null before the first poll. */
	#known: Map<string, string> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#polling = false;
	/** Bumped by stop(): a loop of an older generation ends. */
	#gen = 0;

	constructor(
		source: LeaseSource,
		options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
	) {
		this.#source = source;
		this.#intervalMs = options.intervalMs ?? 2_000;
		this.#onError = options.onError;
	}

	get listeners(): number {
		return this.#listeners.size;
	}

	subscribe(listener: LeaseListener): () => void {
		this.#listeners.add(listener);
		if (this.#listeners.size === 1) this.#schedule(0);
		return () => {
			if (!this.#listeners.delete(listener)) return;
			if (this.#listeners.size === 0) this.stop();
		};
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#known = null;
		this.#gen++;
	}

	/** One poll: emit what changed since the last one. Exposed for tests. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const rows = await this.#source.leases();
			const now = new Map(
				rows.map((r) => [
					r.beadId,
					`${r.lease.heartbeatAt}|${r.lease.expiresAt}`,
				]),
			);
			const before = this.#known;
			this.#known = now;
			// The first poll is the baseline: the snapshot already has these leases.
			if (!before) return;
			const changes: LeaseChange[] = [];
			for (const r of rows) {
				if (before.get(r.beadId) !== now.get(r.beadId)) changes.push(r);
			}
			for (const id of before.keys()) {
				if (!now.has(id)) changes.push({ beadId: id });
			}
			for (const change of changes) {
				for (const listener of this.#listeners) {
					try {
						listener(change);
					} catch (error) {
						this.#onError?.(error);
					}
				}
			}
		} catch (error) {
			this.#onError?.(error);
		} finally {
			this.#polling = false;
		}
	}

	#schedule(ms: number): void {
		const gen = this.#gen;
		this.#timer = setTimeout(async () => {
			await this.poll();
			if (gen === this.#gen && this.#listeners.size > 0)
				this.#schedule(this.#intervalMs);
		}, ms);
	}
}
