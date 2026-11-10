/**
 * The dispatcher: hands one bead to one runner and takes the runner's reports.
 * Transport-free; `nats.ts` binds it to the subjects of `@mastermind/bus`.
 *
 * - next: the router picks a ready bead of the queue, beads claims it as
 *   `<account>/<runner>`. A lost claim race tries the next bead. With no work the
 *   request waits (long poll) until the queue gets work or `waitMs` passes.
 * - heartbeat / report / complete / release: only the actor that holds the
 *   bead may call them.
 * - sweep: beads whose lease died go back to their queue.
 * - onEvent: a journal event routes a bead with no queue and wakes the waiters
 *   of a queue that has ready work.
 */
import { AlreadyClaimed, BdError, NotFound } from "@mastermind/beads";
import { BusError } from "@mastermind/bus";
import {
	type Ack,
	type Bead,
	type BeadComment,
	type BeadEvent,
	type CompleteRequest,
	columnOf,
	type Dispatch,
	type DispatchEnv,
	type HeartbeatReply,
	type HeartbeatRequest,
	isAgentActor,
	leaseState,
	type NextReply,
	type NextRequest,
	queueLabel,
	queueOf,
	type ReadyNotice,
	type ReleaseRequest,
	type ReportRequest,
	type RunnerInfo,
} from "@mastermind/core";
import {
	type RoutingRule,
	type RunnerState,
	route,
	selectBead,
	selectWaiter,
} from "@mastermind/router";
import { envOf } from "../beads/env.ts";
import type { Work } from "./work.ts";

/** How long `next` waits for work before it answers `{dispatch: null}`. */
export const DEFAULT_WAIT_MS = 20_000;

/**
 * What the dispatcher saw of runners, for the live runner list on /people.
 * `next`: a runner asked for work. `holds`: an actor holds a bead (claimed
 * or heartbeat). `done`: it let go (complete, release, dead lease).
 */
export type DispatchSeen =
	| { kind: "next"; runner: RunnerInfo; queue: string }
	| { kind: "holds"; actor: string; beadId: string }
	| { kind: "done"; actor: string; beadId: string };

export type DispatcherOptions = {
	work: Work;
	/** Told what runners do; must not throw. */
	observe?: (seen: DispatchSeen) => void;
	/** Tell every replica that a queue has work (publishes mm.q.<queue>.ready). */
	notify?: (notice: ReadyNotice) => void;
	/** Routing rules, read on every routing decision. */
	rules?: () => readonly RoutingRule[];
	/** The environment of a dispatch. Default: {@link defaultEnv}. */
	env?: (bead: Bead, queue: string) => DispatchEnv;
	/**
	 * Long-poll wait. Adapters must use a request timeout longer than this, or a
	 * bead claimed for them is lost until its lease dies.
	 */
	waitMs?: number;
	/** The actor the dispatcher writes as (routing labels). */
	actor?: string;
	now?: () => Date;
	onError?: (error: unknown) => void;
};

/** Read from the bead's labels: repo:, ref:, provider:, req: (see beads/env.ts). */
export function defaultEnv(bead: Bead): DispatchEnv {
	return envOf(bead);
}

/** Title, description, acceptance, then the notes humans left on the bead. */
export function promptOf(
	bead: Bead,
	notes: readonly BeadComment[] = [],
): string {
	const parts = [bead.title];
	if (bead.description) parts.push(bead.description);
	if (bead.acceptance) parts.push(`Acceptance:\n${bead.acceptance}`);
	if (notes.length) {
		parts.push(
			`Notes:\n${notes.map((n) => `- ${n.author} (${n.createdAt}): ${n.text}`).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

type Waiter = RunnerState & {
	actor: string;
	queue: string;
	resolve: (reply: NextReply) => void;
	timer: ReturnType<typeof setTimeout>;
};

const AGENT = /^[^\s/.*>~]+$/;

/** The runner from a `next` request; its account must be the subject's. */
export function checkRunner(account: string, req: NextRequest): RunnerInfo {
	const r = (req as Partial<NextRequest> | undefined)?.runner;
	const strings = (v: unknown): v is string[] =>
		Array.isArray(v) && v.every((s) => typeof s === "string");
	if (
		!r ||
		typeof r.id !== "string" ||
		!AGENT.test(r.id) ||
		typeof r.account !== "string" ||
		typeof r.serviceAccount !== "string" ||
		!strings(r.providers) ||
		!strings(r.capabilities)
	) {
		throw new BusError("bad_request", "runner is missing or malformed");
	}
	if (r.account !== account) {
		throw new BusError("forbidden", `runner belongs to ${r.account}`);
	}
	return r;
}

/** The actor of a bead verb; it must be `<account>/<agent>` of the subject's account. */
export function checkActor(account: string, actor: unknown): string {
	if (typeof actor !== "string") {
		throw new BusError("bad_request", "actor is missing");
	}
	const prefix = `${account}/`;
	if (!actor.startsWith(prefix) || !AGENT.test(actor.slice(prefix.length))) {
		throw new BusError("forbidden", `actor ${actor} is not ${prefix}<agent>`);
	}
	return actor;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new BusError("bad_request", `${field} is missing`);
	}
	return value;
}

/** bd refusals as bus errors; anything else stays internal. */
export function busError(error: unknown): unknown {
	if (error instanceof BusError) return error;
	if (error instanceof NotFound)
		return new BusError("not_found", error.message, { cause: error });
	if (error instanceof BdError && error.status >= 400 && error.status < 500)
		return new BusError("conflict", `${error.code}: ${error.message}`, {
			cause: error,
		});
	return error;
}

export class Dispatcher {
	readonly #work: Work;
	readonly #opts: DispatcherOptions;
	readonly #waitMs: number;
	readonly #actor: string;
	readonly #now: () => Date;
	/** Waiting `next` requests per queue, in arrival order. */
	readonly #waiting = new Map<string, Waiter[]>();
	/** When each actor last got a bead (ISO). */
	readonly #served = new Map<string, string>();
	/** Per-queue lock: one claim pass at a time per queue in this replica. */
	readonly #locks = new Map<string, Promise<unknown>>();
	#stopped = false;

	constructor(options: DispatcherOptions) {
		this.#work = options.work;
		this.#opts = options;
		this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
		this.#actor = options.actor ?? "mastermind";
		this.#now = options.now ?? (() => new Date());
	}

	/** Number of `next` requests waiting, for tests and health. */
	waiting(queue?: string): number {
		if (queue !== undefined) return this.#waiting.get(queue)?.length ?? 0;
		let n = 0;
		for (const list of this.#waiting.values()) n += list.length;
		return n;
	}

	async next(
		account: string,
		queue: string,
		req: NextRequest,
	): Promise<NextReply> {
		const runner = checkRunner(account, req);
		const actor = `${account}/${runner.id}`;
		this.#see({ kind: "next", runner, queue });
		const state = this.#state(runner, actor, queue);
		let wait: Promise<NextReply> | null = null;
		const reply = await this.#lock(queue, async () => {
			const ready = await this.#work.ready(queue);
			const dispatch = await this.#take(state, actor, queue, ready);
			if (dispatch || this.#stopped || this.#waitMs <= 0) return { dispatch };
			// Registered under the lock: a ready signal cannot slip in between.
			wait = new Promise<NextReply>((resolve) => {
				const waiter: Waiter = {
					...state,
					actor,
					queue,
					resolve,
					timer: setTimeout(() => {
						this.#drop(waiter);
						resolve({ dispatch: null });
					}, this.#waitMs),
				};
				const list = this.#waiting.get(queue) ?? [];
				list.push(waiter);
				this.#waiting.set(queue, list);
			});
			return null;
		});
		return reply ?? (wait as unknown as Promise<NextReply>);
	}

	/** A queue has work: give it to the runners waiting on it here. */
	async ready(queue: string): Promise<void> {
		if (!this.#waiting.get(queue)?.length) return;
		await this.#lock(queue, async () => {
			const waiters = this.#waiting.get(queue);
			if (!waiters?.length) return;
			const ready = (await this.#work.ready(queue)).filter(
				(b) => queueOf(b) === queue,
			);
			for (const bead of ready) {
				const current = this.#waiting.get(queue) ?? [];
				if (current.length === 0) break;
				const waiter = selectWaiter(bead, current);
				if (!waiter) continue;
				const dispatch = await this.#claim(bead, waiter.actor, queue);
				if (!dispatch) continue;
				this.#drop(waiter);
				waiter.resolve({ dispatch });
			}
		});
	}

	async heartbeat(
		account: string,
		beadId: string,
		req: HeartbeatRequest,
	): Promise<HeartbeatReply> {
		const actor = checkActor(account, req?.actor);
		const bead = await this.#held(beadId, actor);
		if (bead.status !== "in_progress") {
			throw new BusError("conflict", `${beadId} is ${bead.status}`);
		}
		const renewed = await this.#work
			.heartbeat(beadId, actor)
			.catch((e) => Promise.reject(busError(e)));
		if (!renewed.lease) throw new Error(`claim of ${beadId} has no lease`);
		this.#see({ kind: "holds", actor, beadId });
		return { lease: renewed.lease };
	}

	async report(
		account: string,
		beadId: string,
		req: ReportRequest,
	): Promise<Ack> {
		const actor = checkActor(account, req?.actor);
		const message = text(req.message, "message");
		await this.#held(beadId, actor);
		await this.#work
			.comment(beadId, actor, message)
			.catch((e) => Promise.reject(busError(e)));
		return { ok: true };
	}

	async complete(
		account: string,
		beadId: string,
		req: CompleteRequest,
	): Promise<Ack> {
		const actor = checkActor(account, req?.actor);
		const summary = text(req.summary, "summary");
		const bead = await this.#held(beadId, actor);
		if (bead.status !== "closed")
			await this.#work
				.close(beadId, actor, summary)
				.catch((e) => Promise.reject(busError(e)));
		this.#see({ kind: "done", actor, beadId });
		return { ok: true };
	}

	async release(
		account: string,
		beadId: string,
		req: ReleaseRequest,
	): Promise<Ack> {
		const actor = checkActor(account, req?.actor);
		const reason = text(req.reason, "reason");
		const bead = await this.#held(beadId, actor);
		await this.#work
			.comment(beadId, actor, `released: ${reason}`)
			.catch((e) => this.#opts.onError?.(e));
		await this.#work
			.release(beadId, actor)
			.catch((e) => Promise.reject(busError(e)));
		this.#see({ kind: "done", actor, beadId });
		this.#signal(bead);
		return { ok: true };
	}

	/** Give beads with a dead lease back to their queue. Returns their ids. */
	async sweep(): Promise<string[]> {
		const now = this.#now();
		const released: string[] = [];
		for (const bead of await this.#work.claimed()) {
			// Only dispatched work: a bead on a queue, held by an actor.
			if (!bead.assignee || !queueOf(bead)) continue;
			if (leaseState(bead.lease, now) !== "expired") continue;
			try {
				await this.#work.release(bead.id, bead.assignee);
				released.push(bead.id);
				this.#see({ kind: "done", actor: bead.assignee, beadId: bead.id });
				this.#signal(bead);
			} catch (error) {
				this.#opts.onError?.(error);
			}
		}
		return released;
	}

	/** One journal event: route an unrouted bead, wake waiters of a ready queue. */
	async onEvent(event: BeadEvent): Promise<void> {
		const bead = event.bead;
		if (!bead) return;
		const queue = queueOf(bead);
		if (queue) {
			if (columnOf(bead) === "ready") this.#signal(bead);
			return;
		}
		if (bead.status !== "open") return;
		const rules = this.#opts.rules?.() ?? [];
		if (!route(bead, rules)) return;
		// The event's bead may be stale: a label change journals steps (old
		// queue removed, then new one added). Decide on the bead as it is now,
		// or a manual move to another queue gets undone.
		const current = await this.#work.get(bead.id);
		if (current.status !== "open" || queueOf(current)) return;
		const target = route(current, rules);
		if (!target) return;
		// The label change is a new journal event; that one wakes the waiters.
		await this.#work.setLabels(bead.id, this.#actor, [
			...current.labels,
			queueLabel(target),
		]);
	}

	/** Answer every waiting request with no dispatch. */
	stop(): void {
		this.#stopped = true;
		for (const list of this.#waiting.values()) {
			for (const w of list) {
				clearTimeout(w.timer);
				w.resolve({ dispatch: null });
			}
		}
		this.#waiting.clear();
	}

	#state(runner: RunnerInfo, actor: string, queue: string): RunnerState {
		const lastServedAt = this.#served.get(actor);
		return {
			user: runner.account,
			runner: runner.id,
			queues: [queue],
			capabilities: runner.capabilities,
			// One request asks for one bead.
			capacity: 1,
			running: 0,
			...(lastServedAt ? { lastServedAt } : {}),
		};
	}

	/** The router's pick among `ready`; a lost claim race tries the next one. */
	async #take(
		state: RunnerState,
		actor: string,
		queue: string,
		ready: Bead[],
	): Promise<Dispatch | null> {
		let left = ready;
		for (;;) {
			const pick = selectBead(state, queue, left);
			if (!pick) return null;
			const dispatch = await this.#claim(pick, actor, queue);
			if (dispatch) return dispatch;
			left = left.filter((b) => b !== pick);
		}
	}

	/** Claim `bead` for `actor`; null when somebody else won it. */
	async #claim(
		bead: Bead,
		actor: string,
		queue: string,
	): Promise<Dispatch | null> {
		let claimed: Bead;
		try {
			const res = await this.#work.claim(bead.id, actor);
			// Same actor twice: the other request already got this bead.
			if (res.alreadyClaimed) return null;
			claimed = res.bead;
		} catch (error) {
			if (error instanceof AlreadyClaimed || error instanceof NotFound)
				return null;
			throw error;
		}
		if (!claimed.lease) throw new Error(`claim of ${bead.id} has no lease`);
		this.#served.set(actor, this.#now().toISOString());
		this.#see({ kind: "holds", actor, beadId: bead.id });
		// The claim reply has no labels; the ready list has them.
		const held: Bead = {
			...bead,
			status: claimed.status,
			assignee: claimed.assignee ?? actor,
			lease: claimed.lease,
			updatedAt: claimed.updatedAt,
		};
		return {
			bead: held,
			queue,
			actor,
			lease: claimed.lease,
			stage: "work",
			env: (this.#opts.env ?? defaultEnv)(held, queue),
			prompt: promptOf(held, await this.#notes(bead.id)),
		};
	}

	/** Notes humans left on a bead (not runner reports); none when unreadable. */
	async #notes(beadId: string): Promise<BeadComment[]> {
		if (!this.#work.notes) return [];
		try {
			return (await this.#work.notes(beadId)).filter(
				(c) => !isAgentActor(c.author),
			);
		} catch (error) {
			this.#opts.onError?.(error);
			return [];
		}
	}

	/** The bead, if `actor` holds it; else conflict. */
	async #held(beadId: string, actor: string): Promise<Bead> {
		let bead: Bead;
		try {
			bead = await this.#work.get(beadId);
		} catch (error) {
			throw busError(error);
		}
		if (bead.assignee !== actor) {
			throw new BusError("conflict", `${beadId} is not held by ${actor}`);
		}
		return bead;
	}

	#see(seen: DispatchSeen): void {
		try {
			this.#opts.observe?.(seen);
		} catch (error) {
			this.#opts.onError?.(error);
		}
	}

	#signal(bead: Bead): void {
		const queue = queueOf(bead);
		if (!queue) return;
		this.#opts.notify?.({
			queue,
			beadId: bead.id,
			at: this.#now().toISOString(),
		});
	}

	#drop(waiter: Waiter): void {
		clearTimeout(waiter.timer);
		const list = this.#waiting.get(waiter.queue);
		if (!list) return;
		const i = list.indexOf(waiter);
		if (i >= 0) list.splice(i, 1);
		if (list.length === 0) this.#waiting.delete(waiter.queue);
	}

	#lock<T>(queue: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#locks.get(queue) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const tail = run.catch(() => {});
		this.#locks.set(queue, tail);
		void tail.then(() => {
			if (this.#locks.get(queue) === tail) this.#locks.delete(queue);
		});
		return run;
	}
}
