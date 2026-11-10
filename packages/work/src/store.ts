/**
 * The work store on NATS JetStream. It does what beads (bd serve + Dolt) did
 * for Mastermind: items, claims, leases, an ordered journal and timelines.
 *
 *   stream MM_WORK, subjects mm.work.<id>, file storage
 *     one message = one mutation of one item: {op, at, actor, bead, comment?}
 *     current item = the last message of its subject
 *     journal seq  = stream sequence; timeline of an item = its subject
 *   every write is a compare-and-set on the item's subject (expected last
 *   subject sequence), so create/claim/release/close/reopen/labels are atomic
 *   KV mm_work_leases: lease renewals (heartbeats), so they do not flood the
 *   journal. The claim message carries the first lease; a later renewal by the
 *   same holder wins.
 *   board: an in-memory projection, loaded last-per-subject and then kept live
 *   by the same ordered consumer (push, no polling).
 *
 * Not here yet: dependencies (`blocked` is always false), bd CLI access, Dolt
 * history. Closed items leave the board (and memory) `doneForMs` after they
 * close; they stay in the stream, so get, timeline and activity still read them.
 */
import { Store, type StoreWatch } from "@mastermind/bus";
import {
	type Bead,
	type BeadComment,
	type BeadEvent,
	type Lease,
	leaseState,
	type Probe,
	queueLabel,
	queueOf,
} from "@mastermind/core";
import {
	type ConsumerMessages,
	DeliverPolicy,
	DiscardPolicy,
	type JetStreamClient,
	type JetStreamManager,
	jetstream,
	jetstreamManager,
	StorageType,
	type StoredMsg,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import {
	AlreadyClaimed,
	type ClaimResult,
	type CreateBead,
	NotFound,
	WorkError,
} from "./errors.ts";

export type WorkOp =
	| "create"
	| "claim"
	| "release"
	| "update"
	| "close"
	| "reopen"
	| "comment";

/** One message of the stream: one mutation of one item, with the item after it. */
export type WorkRecord = {
	op: WorkOp;
	at: string;
	actor: string;
	bead: Bead;
	comment?: BeadComment;
};

/** A lease renewal in the KV bucket. */
type LeaseValue = Lease & { holder: string };

export type NatsWorkOptions = {
	/** Stream name. Default MM_WORK. */
	stream?: string;
	/** Subject root: items are `<subject>.<id>`. Default mm.work. */
	subject?: string;
	/** KV bucket for lease renewals. Default mm_work_leases. */
	leaseBucket?: string;
	/** Id prefix: `<prefix>-<base36>`. Default mm. */
	prefix?: string;
	/** Lease term. Default 5 min. */
	leaseMs?: number;
	/** Closed items stay on the board this long. Default 7 days. */
	doneForMs?: number;
	/** How long open() waits for the board to load. Default 30 s. */
	loadTimeoutMs?: number;
	/**
	 * Stream size cap. Default 1 GiB. With discard "new" a full stream refuses
	 * writes (loudly) instead of deleting the oldest messages, which would
	 * delete live items: an item and its history share the stream.
	 */
	maxBytes?: number;
	now?: () => Date;
	onError?: (error: unknown) => void;
};

export const LEASE_MS = 5 * 60_000;
const DONE_FOR_MS = 7 * 24 * 60 * 60_000;
export const MAX_BYTES = 1024 ** 3;
const PAGE = 500;
const MAX_ATTEMPTS = 25;

/** JetStream reports a failed compare-and-set as "wrong last sequence" (10071). */
function isWrongLast(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		(err as { code?: unknown }).code === 10071 ||
		/wrong last sequence/i.test(err.message)
	);
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const problem = (status: number, code: string, detail: string, extra = {}) => ({
	status,
	title: code,
	code,
	detail,
	...extra,
});
const notFound = (id: string) =>
	new NotFound(problem(404, "not_found", `no item ${id}`));

const ON_BOARD = new Set(["open", "in_progress", "hooked", "blocked"]);

function byBoardOrder(a: Bead, b: Bead): number {
	return (
		a.priority - b.priority ||
		a.createdAt.localeCompare(b.createdAt) ||
		a.id.localeCompare(b.id)
	);
}

/** The bead with the lease that counts: the claim's, or a later renewal by the same holder. */
function withLease(bead: Bead, renewal?: LeaseValue): Bead {
	const out = structuredClone(bead);
	if (out.status !== "in_progress" || !out.assignee) {
		delete out.lease;
		return out;
	}
	if (
		renewal &&
		renewal.holder === out.assignee &&
		(!out.lease || renewal.heartbeatAt > out.lease.heartbeatAt)
	) {
		out.lease = {
			expiresAt: renewal.expiresAt,
			heartbeatAt: renewal.heartbeatAt,
		};
	}
	return out;
}

function toEvent(m: StoredMsg): BeadEvent {
	const r = m.json<WorkRecord>();
	const event: BeadEvent = {
		seq: m.seq,
		at: r.at,
		op: r.op,
		beadId: r.bead.id,
		actor: r.actor,
		bead: r.bead,
	};
	if (r.comment) event.comment = r.comment;
	return event;
}

const enc = new TextEncoder();

type Item = { bead: Bead; seq: number };
type Waiter = { after: number; done: () => void };

export class NatsWork {
	readonly #js: JetStreamClient;
	readonly #jsm: JetStreamManager;
	readonly #leases: Store<LeaseValue>;
	readonly #stream: string;
	readonly #subject: string;
	readonly #prefix: string;
	readonly #leaseMs: number;
	readonly #doneForMs: number;
	readonly #maxBytes: number;
	readonly #now: () => Date;
	readonly #onError?: (error: unknown) => void;
	/** The projection: every item the consumer has seen, by id. */
	readonly #items = new Map<string, Item>();
	readonly #renewals = new Map<string, LeaseValue>();
	readonly #waiters = new Set<Waiter>();
	readonly #listeners = new Set<(event: BeadEvent) => void>();
	/** Highest stream seq applied to the projection. */
	#cursor = 0;
	/** Highest seq this instance wrote: projection reads wait for it (read your writes). */
	#written = 0;
	#messages: ConsumerMessages | null = null;
	#watch: StoreWatch<LeaseValue> | null = null;
	#stopped = false;

	private constructor(
		js: JetStreamClient,
		jsm: JetStreamManager,
		leases: Store<LeaseValue>,
		opts: NatsWorkOptions,
	) {
		this.#js = js;
		this.#jsm = jsm;
		this.#leases = leases;
		this.#stream = opts.stream ?? "MM_WORK";
		this.#subject = opts.subject ?? "mm.work";
		this.#prefix = opts.prefix ?? "mm";
		this.#leaseMs = opts.leaseMs ?? LEASE_MS;
		this.#doneForMs = opts.doneForMs ?? DONE_FOR_MS;
		this.#maxBytes = opts.maxBytes ?? MAX_BYTES;
		this.#now = opts.now ?? (() => new Date());
		this.#onError = opts.onError;
	}

	/** Create the stream and the lease bucket if needed, then load the board. */
	static async open(
		nc: NatsConnection,
		opts: NatsWorkOptions = {},
	): Promise<NatsWork> {
		const jsm = await jetstreamManager(nc);
		const leases = await Store.open<LeaseValue>(
			nc,
			opts.leaseBucket ?? "mm_work_leases",
			// A renewal outlives its lease by far; older ones are noise.
			{ ttlMs: 24 * 60 * 60_000 },
		);
		const work = new NatsWork(jetstream(nc), jsm, leases, opts);
		const head = await work.#ensureStream();
		await work.#start(head, opts.loadTimeoutMs ?? 30_000);
		return work;
	}

	/**
	 * Stream settings: file storage, 1 replica (one server), no age or count
	 * limit, `maxBytes` with discard new, direct get on. An existing stream
	 * gets the size settings updated; storage and subjects are never changed.
	 */
	async #ensureStream(): Promise<number> {
		const limits = {
			max_bytes: this.#maxBytes,
			discard: DiscardPolicy.New,
			allow_direct: true,
		};
		try {
			const info = await this.#jsm.streams.info(this.#stream);
			const c = info.config;
			if (
				c.max_bytes !== limits.max_bytes ||
				c.discard !== limits.discard ||
				!c.allow_direct
			)
				await this.#jsm.streams.update(this.#stream, limits);
			return info.state.last_seq;
		} catch (error) {
			if ((error as { code?: unknown }).code !== 10059) throw error;
		}
		const info = await this.#jsm.streams.add({
			name: this.#stream,
			subjects: [`${this.#subject}.>`],
			storage: StorageType.File,
			num_replicas: 1,
			...limits,
		});
		return info.state.last_seq;
	}

	/** Bytes used and the cap, for health. */
	async usage(): Promise<{ bytes: number; maxBytes: number }> {
		const info = await this.#jsm.streams.info(this.#stream);
		return { bytes: info.state.bytes, maxBytes: info.config.max_bytes };
	}

	async #start(head: number, timeoutMs: number): Promise<void> {
		this.#watch = await this.#leases.watch();
		const watch = this.#watch;
		void (async () => {
			for await (const e of watch) {
				if (e.op === "put") this.#renewals.set(e.key, e.value);
				else this.#renewals.delete(e.key);
			}
		})().catch((error) => this.#onError?.(error));

		const loaded = this.waitFor(head - 1, timeoutMs);
		void this.#follow();
		if (head > 0) {
			await loaded;
			if (this.#cursor < head) {
				this.stop();
				throw new Error(`work: board did not load in ${timeoutMs}ms`);
			}
		}
	}

	/** One ordered consumer: last message per item first, then every new one. */
	async #follow(): Promise<void> {
		while (!this.#stopped) {
			try {
				const consumer = await this.#js.consumers.get(this.#stream, {
					filter_subjects: [`${this.#subject}.>`],
					...(this.#cursor === 0
						? { deliver_policy: DeliverPolicy.LastPerSubject }
						: {
								deliver_policy: DeliverPolicy.StartSequence,
								opt_start_seq: this.#cursor + 1,
							}),
				});
				const messages = await consumer.consume();
				this.#messages = messages;
				if (this.#stopped) messages.stop();
				for await (const m of messages) {
					this.#apply(m.seq, m.json<WorkRecord>());
				}
			} catch (error) {
				if (this.#stopped) return;
				this.#onError?.(error);
				await Bun.sleep(1_000);
			}
		}
	}

	#apply(seq: number, r: WorkRecord): void {
		if (seq <= this.#cursor) return;
		const id = r.bead.id;
		const prev = this.#items.get(id);
		if (!prev || prev.seq < seq) this.#items.set(id, { bead: r.bead, seq });
		this.#cursor = seq;
		const event: BeadEvent = {
			seq,
			at: r.at,
			op: r.op,
			beadId: id,
			actor: r.actor,
			bead: r.bead,
			...(r.comment ? { comment: r.comment } : {}),
		};
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				this.#onError?.(error);
			}
		}
		for (const w of this.#waiters) if (seq > w.after) w.done();
	}

	stop(): void {
		this.#stopped = true;
		this.#messages?.stop();
		this.#watch?.stop();
		for (const w of this.#waiters) w.done();
	}

	// ---- reads from the projection -------------------------------------

	/** Highest journal seq the projection holds; 0 when empty. */
	async head(): Promise<number> {
		await this.#caughtUp();
		return this.#cursor;
	}

	/** Wait (at most 2 s) until the projection holds this instance's last write. */
	#caughtUp(): Promise<void> {
		return this.waitFor(this.#written - 1, 2_000);
	}

	/** Resolves when the projection passes `after`, or after `ms`. */
	waitFor(after: number, ms: number, signal?: AbortSignal): Promise<void> {
		if (this.#cursor > after || this.#stopped || signal?.aborted)
			return Promise.resolve();
		return new Promise((resolve) => {
			const w: Waiter = { after, done: () => {} };
			const timer = setTimeout(() => w.done(), ms);
			const onAbort = () => w.done();
			w.done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#waiters.delete(w);
				resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#waiters.add(w);
		});
	}

	/** Every event as the projection applies it. Returns unsubscribe. */
	subscribe(listener: (event: BeadEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async #live(filter: (b: Bead) => boolean): Promise<Bead[]> {
		await this.#caughtUp();
		const out: Bead[] = [];
		for (const { bead } of this.#items.values()) {
			if (filter(bead)) out.push(withLease(bead, this.#renewals.get(bead.id)));
		}
		return out.sort(byBoardOrder);
	}

	/** Open and in-progress items, and items closed in the last `doneForMs`. */
	async board(): Promise<Bead[]> {
		const cutoff = new Date(
			this.#now().getTime() - this.#doneForMs,
		).toISOString();
		for (const [id, { bead }] of this.#items) {
			// Old closed items leave memory; the stream keeps them.
			if (bead.status === "closed" && (bead.closedAt ?? "") < cutoff)
				this.#items.delete(id);
		}
		return this.#live((b) => ON_BOARD.has(b.status) || b.status === "closed");
	}

	async ready(queue: string): Promise<Bead[]> {
		const label = queueLabel(queue);
		return this.#live(
			(b) => b.status === "open" && !b.blocked && b.labels.includes(label),
		);
	}

	async claimed(): Promise<Bead[]> {
		return this.#live((b) => b.status === "in_progress");
	}

	async unrouted(): Promise<Bead[]> {
		return this.#live((b) => b.status === "open" && queueOf(b) === null);
	}

	/** Every live lease, for the board's lease stream. */
	async leases(): Promise<{ beadId: string; lease: Lease }[]> {
		return (await this.claimed()).flatMap((b) =>
			b.lease ? [{ beadId: b.id, lease: b.lease }] : [],
		);
	}

	// ---- reads from the stream -----------------------------------------

	#subj(id: string): string {
		if (!ID.test(id)) throw notFound(id);
		return `${this.#subject}.${id}`;
	}

	async #read(id: string): Promise<Item | null> {
		const m = await this.#jsm.streams.getMessage(this.#stream, {
			last_by_subj: this.#subj(id),
		});
		if (!m) return null;
		return { bead: m.json<WorkRecord>().bead, seq: m.seq };
	}

	async #renewal(id: string): Promise<LeaseValue | undefined> {
		return (await this.#leases.get(id))?.value;
	}

	/** The item as it is now, with its live lease. */
	async get(id: string): Promise<Bead> {
		const [cur, renewal] = await Promise.all([
			this.#read(id),
			this.#renewal(id),
		]);
		if (!cur) throw notFound(id);
		return withLease(cur.bead, renewal);
	}

	/** Direct batch read; an empty range is an empty list. */
	async #batch(
		opts: { seq: number; batch: number; next_by_subj?: string },
		limit: number,
	): Promise<BeadEvent[]> {
		const out: BeadEvent[] = [];
		let seq = opts.seq;
		while (out.length < limit) {
			const batch = Math.min(PAGE, limit - out.length, opts.batch);
			let got = 0;
			try {
				const it = await this.#jsm.direct.getBatch(this.#stream, {
					seq,
					batch,
					...(opts.next_by_subj ? { next_by_subj: opts.next_by_subj } : {}),
				});
				for await (const m of it) {
					out.push(toEvent(m));
					seq = m.seq + 1;
					got++;
				}
			} catch (error) {
				// 404: nothing (more) in the range.
				if (!/no (message|results)|404/i.test(String(error))) throw error;
			}
			if (got < batch) break;
		}
		return out;
	}

	/** Events after `seq`, up to what the projection holds, in seq order. */
	async journalSince(seq: number, limit = PAGE): Promise<BeadEvent[]> {
		const head = this.#cursor;
		if (seq >= head) return [];
		const events = await this.#batch(
			{ seq: seq + 1, batch: Math.min(limit, head - seq) },
			Math.min(limit, head - seq),
		);
		return events.filter((e) => e.seq <= head);
	}

	/** Every event of one item, oldest first. */
	async journalOf(id: string, limit = 2_000): Promise<BeadEvent[]> {
		return this.#batch(
			{ seq: 1, batch: limit, next_by_subj: this.#subj(id) },
			limit,
		);
	}

	/** The newest events, newest first, with seq below `before` when given. */
	async journalRecent(limit = 200, before?: number): Promise<BeadEvent[]> {
		const end = Math.min(before ?? this.#cursor + 1, this.#cursor + 1);
		const start = Math.max(1, end - limit);
		if (end <= start) return [];
		const events = await this.#batch(
			{ seq: start, batch: end - start },
			end - start,
		);
		return events.filter((e) => e.seq < end).reverse();
	}

	/** Comments of one item, oldest first. */
	async comments(id: string): Promise<BeadComment[]> {
		return (await this.journalOf(id)).flatMap((e) =>
			e.comment ? [e.comment] : [],
		);
	}

	notes(id: string): Promise<BeadComment[]> {
		return this.comments(id);
	}

	async probe(): Promise<Probe> {
		if (this.#stopped) return "down";
		try {
			await this.#jsm.streams.info(this.#stream);
			return "up";
		} catch {
			return "down";
		}
	}

	// ---- writes: one compare-and-set message each -----------------------

	async #publish(
		id: string,
		record: WorkRecord,
		lastSeq: number,
	): Promise<number> {
		const ack = await this.#js.publish(
			this.#subj(id),
			enc.encode(JSON.stringify(record)),
			{ expect: { lastSubjectSequence: lastSeq } },
		);
		this.#written = Math.max(this.#written, ack.seq);
		return ack.seq;
	}

	/**
	 * Read the item, let `change` decide, write with compare-and-set; a lost
	 * race reads again and decides again. `change` returns null to write nothing.
	 */
	async #mutate(
		id: string,
		op: WorkOp,
		actor: string,
		change: (
			bead: Bead,
			at: Date,
			renewal: LeaseValue | undefined,
		) => { bead: Bead; comment?: BeadComment } | null,
	): Promise<{ bead: Bead; wrote: boolean }> {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const [cur, renewal] = await Promise.all([
				this.#read(id),
				op === "claim" ? this.#renewal(id) : undefined,
			]);
			if (!cur) throw notFound(id);
			const at = this.#now();
			const next = change(structuredClone(cur.bead), at, renewal);
			if (!next) return { bead: withLease(cur.bead, renewal), wrote: false };
			const record: WorkRecord = {
				op,
				at: at.toISOString(),
				actor,
				...next,
			};
			try {
				await this.#publish(id, record, cur.seq);
				return { bead: next.bead, wrote: true };
			} catch (error) {
				if (!isWrongLast(error)) throw error;
			}
		}
		throw new WorkError(409, "conflict", `${id}: too many concurrent writes`);
	}

	#newId(attempt: number): string {
		// 4 base36 chars (1.7 M), one more for every few collisions.
		const len = 4 + Math.floor(attempt / 3);
		let s = "";
		while (s.length < len) s += Math.random().toString(36).slice(2);
		return `${this.#prefix}-${s.slice(0, len)}`;
	}

	async create(actor: string, input: CreateBead): Promise<Bead> {
		const at = this.#now().toISOString();
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const bead: Bead = {
				id: this.#newId(attempt),
				title: input.title,
				status: "open",
				priority: input.priority ?? 2,
				type: input.type ?? "task",
				labels: [...new Set(input.labels ?? [])],
				blocked: false,
				createdAt: at,
				updatedAt: at,
			};
			if (input.description) bead.description = input.description;
			if (input.acceptance) bead.acceptance = input.acceptance;
			try {
				// Expected last seq 0: the subject must be empty (create-if-absent).
				await this.#publish(bead.id, { op: "create", at, actor, bead }, 0);
				return bead;
			} catch (error) {
				if (!isWrongLast(error)) throw error;
			}
		}
		throw new WorkError(409, "conflict", "no free id");
	}

	/** Atomic. Throws AlreadyClaimed while another actor holds a live lease. */
	async claim(id: string, actor: string): Promise<ClaimResult> {
		let already = false;
		const { bead } = await this.#mutate(
			id,
			"claim",
			actor,
			(b, at, renewal) => {
				already = false;
				if (b.status === "in_progress" && b.assignee === actor) {
					already = true;
					return null;
				}
				const held = withLease(b, renewal);
				if (
					b.status === "in_progress" &&
					b.assignee &&
					leaseState(held.lease, at) === "live"
				)
					throw new AlreadyClaimed(
						problem(409, "already_claimed", `${id} is held`, {
							assignee: b.assignee,
						}),
					);
				if (b.status !== "open" && b.status !== "in_progress")
					throw new WorkError(409, "not_claimable", `${id} is ${b.status}`);
				b.status = "in_progress";
				b.assignee = actor;
				b.lease = this.#lease(at);
				b.updatedAt = at.toISOString();
				return { bead: b };
			},
		);
		return { bead, alreadyClaimed: already };
	}

	#lease(at: Date): Lease {
		return {
			expiresAt: new Date(at.getTime() + this.#leaseMs).toISOString(),
			heartbeatAt: at.toISOString(),
		};
	}

	/** Renews the lease in KV (no journal event). Only the holder may. */
	async heartbeat(id: string, actor: string): Promise<Bead> {
		const cur = await this.#read(id);
		if (!cur) throw notFound(id);
		const b = cur.bead;
		if (b.status !== "in_progress")
			throw new WorkError(409, "heartbeat_refused", `${id} is ${b.status}`);
		if (b.assignee !== actor)
			throw new WorkError(
				409,
				"heartbeat_refused",
				`${id} already claimed by ${b.assignee}`,
			);
		const renewal: LeaseValue = { holder: actor, ...this.#lease(this.#now()) };
		await this.#leases.put(id, renewal);
		this.#renewals.set(id, renewal);
		return withLease(b, renewal);
	}

	async #dropLease(id: string): Promise<void> {
		await this.#leases.delete(id).catch((e) => this.#onError?.(e));
	}

	/** Gives the claim back. Only the holder may. */
	async release(id: string, actor: string): Promise<Bead> {
		const { bead } = await this.#mutate(id, "release", actor, (b, at) => {
			if (b.status !== "in_progress")
				throw new WorkError(409, "not_releasable", `${id} holds no claim`);
			if (b.assignee !== actor)
				throw new WorkError(
					409,
					"not_releasable",
					`${id} is held by ${b.assignee}`,
				);
			b.status = "open";
			delete b.assignee;
			delete b.lease;
			b.updatedAt = at.toISOString();
			return { bead: b };
		});
		await this.#dropLease(id);
		return bead;
	}

	async close(id: string, actor: string, reason?: string): Promise<Bead> {
		const { bead } = await this.#mutate(id, "close", actor, (b, at) => {
			if (b.status === "closed") return null;
			b.status = "closed";
			b.closedAt = at.toISOString();
			b.updatedAt = b.closedAt;
			if (reason) b.closeReason = reason;
			delete b.lease;
			return { bead: b };
		});
		await this.#dropLease(id);
		return bead;
	}

	async reopen(id: string, actor: string, _reason?: string): Promise<Bead> {
		const { bead } = await this.#mutate(id, "reopen", actor, (b, at) => {
			if (b.status !== "closed") return null;
			b.status = "open";
			delete b.closedAt;
			delete b.closeReason;
			delete b.assignee;
			delete b.lease;
			b.updatedAt = at.toISOString();
			return { bead: b };
		});
		return bead;
	}

	async comment(id: string, actor: string, text: string): Promise<BeadComment> {
		let comment: BeadComment | undefined;
		await this.#mutate(id, "comment", actor, (b, at) => {
			comment = {
				id: `c-${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
				beadId: id,
				author: actor,
				text,
				createdAt: at.toISOString(),
			};
			return { bead: b, comment };
		});
		return comment as BeadComment;
	}

	/** Replaces the whole label set. */
	async setLabels(id: string, actor: string, labels: string[]): Promise<Bead> {
		const next = [...new Set(labels)];
		const { bead } = await this.#mutate(id, "update", actor, (b, at) => {
			const same =
				b.labels.length === next.length &&
				b.labels.every((l) => next.includes(l));
			if (same) return null;
			b.labels = next;
			b.updatedAt = at.toISOString();
			return { bead: b };
		});
		return this.#withRenewal(bead);
	}

	#withRenewal(bead: Bead): Bead {
		return withLease(bead, this.#renewals.get(bead.id));
	}
}
