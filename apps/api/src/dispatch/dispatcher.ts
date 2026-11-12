/**
 * The dispatcher: hands one bead to one runner and takes the runner's reports.
 * Transport-free; `nats.ts` binds it to the subjects of `@mastermind/bus`.
 *
 * - next: the router picks a ready bead of the queue, beads claims it as
 *   `<account>/<runner>`. A lost claim race tries the next bead. With no work the
 *   request waits (long poll) until the queue gets work or `waitMs` passes.
 * - heartbeat / report / complete / release: only the actor that holds the
 *   bead may call them.
 * - back-off: a runner that released a bead does not get it again for 1 min,
 *   then 5 min, then not at all (per runner+bead, in memory). After
 *   {@link MAX_FAILED_STARTS} failed starts (any runner) the bead gets
 *   {@link FAILED_START_LABEL} and a note; a human reopen removes the label.
 * - max attempts (mm-210.65): a bead claimed and then released or expired
 *   {@link MAX_ATTEMPTS} times (any runner, any reason; option `maxAttempts`)
 *   gets {@link NEEDS_HUMAN_LABEL} and a note with the last reasons, and is
 *   not offered until a human reopen removes the label. Prior art: SQS
 *   maxReceiveCount + dead-letter queue, Temporal maximumAttempts. Counts are
 *   in memory, as the back-off.
 * - sweep: beads whose lease died go back to their queue.
 * - onEvent: a journal event routes a bead with no queue and wakes the waiters
 *   of a queue that has ready work.
 * - direct (mm-210.32): a bead with `to:<address>` is OFFERED to that runner,
 *   or to each online runner of that account (served least recently first).
 *   The runner accepts or declines with a reason; on accept the bead is
 *   claimed for it and the dispatch goes back in the same exchange. When
 *   nobody accepts, the bead gets {@link NOT_ACCEPTED_LABEL} and a note with
 *   the reasons and waits (or goes to the rule's fallback queue); a waiting
 *   bead is offered again every `retryMs` ({@link Dispatcher.retryDirect}).
 * - debug(): the waiters per queue and a ring of recent decisions (offers and
 *   declines with the reason), for GET /api/debug/state. In memory, this
 *   replica only.
 * - sessions (mm-210.79): one live process per runner ({@link RunnerSessions}).
 *   A `next`, status or offer answer of a process that a newer one replaced
 *   gets `superseded`; its waiting `next` is answered at once, so a runner
 *   never waits twice. A runner without session id is held `waitMs` first.
 * - readiness gate (mm-210.59): with `readiness`, a runner gets work (next,
 *   wake-up, offer) only while its last status is `ready`, fresh
 *   ({@link READINESS_FRESH_MS}) and lists the item's environment; items
 *   with no environment need `ready` only. A runner that is not ready waits
 *   on `next` until it is (or `waitMs`), then gets `{notReady: reasons}`.
 */

import { BusError } from "@mastermind/bus";
import {
	type Ack,
	type Bead,
	type BeadComment,
	type BeadEvent,
	type CompleteRequest,
	columnOf,
	type DirectOffer,
	type Dispatch,
	type DispatchEnv,
	directQueue,
	ENV_TRIAGE_LABEL,
	envNameOf,
	FAILED_START_LABEL,
	type HeartbeatReply,
	type HeartbeatRequest,
	isAgentActor,
	leaseState,
	NEEDS_HUMAN_LABEL,
	type NextReply,
	type NextRequest,
	NOT_ACCEPTED_LABEL,
	notReadyReasons,
	type OfferResult,
	type ProcessOf,
	parseAddress,
	queueLabel,
	queueOf,
	READINESS_FRESH_MS,
	type ReadyNotice,
	type ReleaseRequest,
	type ReportRequest,
	type RunnerInfo,
	type RunnerReadiness,
	TO_LABEL_PREFIX,
	toLabel,
	toOf,
	workOutputOf,
} from "@mastermind/core";
import {
	fallbackOf,
	offerOrder,
	type RoutingRule,
	type RunnerState,
	selectBead,
	selectWaiter,
	target,
} from "@mastermind/router";
import { AlreadyClaimed, NotFound, WorkError } from "@mastermind/work";
import { envOf } from "../beads/env.ts";
import {
	type DuplicateSession,
	RunnerSessions,
	type SessionClaim,
} from "./sessions.ts";
import type { Work } from "./work.ts";

/** How long `next` waits for work before it answers `{dispatch: null}`. */
export const DEFAULT_WAIT_MS = 20_000;

/** Back-off of a runner after its 1st, 2nd release of a bead; then never. */
export const RELEASE_BACKOFF_MS = [60_000, 300_000] as const;

/** Failed starts of a bead (any runner) before it is held back. */
export const MAX_FAILED_STARTS = 3;

/** Attempts (claim, then release or lease expiry) of a bead before it needs a human. */
export const MAX_ATTEMPTS = 3;

/** Reasons of the last attempts kept for the needs-a-human note. */
const ATTEMPT_REASONS_KEPT = 3;

/** A direct bead that nobody accepted is offered again after this. */
export const DIRECT_RETRY_MS = 30_000;

/**
 * How one offer to one runner ended (the transport's view). `accepted`: the
 * runner wants it; `reply` sends it the result (the dispatch, or null with
 * the reason) and must be called exactly once.
 */
export type OfferExchange =
	| {
			kind: "accepted";
			runner: RunnerInfo;
			reply: (result: OfferResult) => void;
	  }
	| { kind: "declined"; reason: string }
	| { kind: "offline" }
	| { kind: "timeout" };

/** Recent decisions kept for the debug view. */
export const DECISIONS_KEPT = 100;

/**
 * One decision of the dispatcher about a bead. `offer`: the bead was claimed
 * for `actor`. `decline`: the bead was not given (to `actor`, if set) and why.
 * The same decision again updates `at` and adds 1 to `count`.
 */
export type DispatchDecision = {
	at: string;
	kind: "offer" | "decline";
	queue: string;
	beadId: string;
	actor?: string;
	reason: string;
	count: number;
};

/** What `debug()` shows: runners waiting on `next`, recent decisions (oldest first). */
export type DispatcherDebug = {
	waiters: Record<
		string,
		{
			actor: string;
			since: string;
			environments?: string[];
			session?: string;
		}[]
	>;
	decisions: DispatchDecision[];
	/** Runners with a second process that is refused (mm-210.79). */
	sessions?: DuplicateSession[];
};

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
	 * Resolve the environment before a claim (named environments). A bead
	 * that does not resolve is not dispatched: it gets the label
	 * {@link ENV_TRIAGE_LABEL} and a note with the reason. Wins over `env`.
	 */
	resolveEnv?: (bead: Bead, queue: string) => EnvResolution;
	/**
	 * Long-poll wait. Adapters must use a request timeout longer than this, or a
	 * bead claimed for them is lost until its lease dies.
	 */
	waitMs?: number;
	/** The actor the dispatcher writes as (routing labels). */
	actor?: string;
	/** Offer a direct bead to one runner. Without it, direct beads wait. */
	offer?: (
		account: string,
		runner: string,
		offer: DirectOffer,
	) => Promise<OfferExchange>;
	/** Ids of the online runners of an account (for an account address). */
	runnersOf?: (account: string) => string[];
	/** Offer a waiting direct bead again after this. Default {@link DIRECT_RETRY_MS}. */
	retryMs?: number;
	/**
	 * The readiness gate (mm-210.59): a runner's last status and when it came
	 * (ms, this server's clock); null: none. Absent: no gate.
	 */
	readiness?: (account: string, runner: string) => RunnerStatusSeen | null;
	/**
	 * Attempts before a bead needs a human (a setting of its environment or
	 * queue). Absent or undefined: {@link MAX_ATTEMPTS}.
	 */
	maxAttempts?: (bead: Bead) => number | undefined;
	/** One live session per runner. Default: a new {@link RunnerSessions}. */
	sessions?: RunnerSessions;
	now?: () => Date;
	onError?: (error: unknown) => void;
};

/** A runner's last status as the dispatcher sees it. */
export type RunnerStatusSeen = {
	status: { readiness?: RunnerReadiness } & ProcessOf;
	receivedAt: number;
};

/** How often a `next` of a runner that is not ready looks again. */
export const NOT_READY_POLL_MS = 1_000;

export { READINESS_FRESH_MS };

export type EnvResolution =
	| { ok: true; env: DispatchEnv }
	| { ok: false; reason: string };

export { ENV_TRIAGE_LABEL, FAILED_START_LABEL, NEEDS_HUMAN_LABEL };

/** Read from the bead's labels: repo:, ref:, req: (see beads/env.ts). */
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

/** The prompt with the environment's instructions, if it has any. */
export function withInstructions(prompt: string, env: DispatchEnv): string {
	return env.instructions
		? `${prompt}\n\nEnvironment ${env.name ?? ""} instructions:\n${env.instructions}`
		: prompt;
}

type Waiter = RunnerState & {
	/** The runner's bound environments; absent: any. */
	environments?: string[];
	/** The process's session; absent: a runner older than mm-210.79. */
	session?: string;
	/** The runner's version (tells two older processes apart). */
	version?: string;
	actor: string;
	queue: string;
	/** When the runner started to wait (ISO). */
	since: string;
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
		!strings(r.capabilities) ||
		(r.environments !== undefined && !strings(r.environments)) ||
		(r.session !== undefined && typeof r.session !== "string") ||
		(r.startedAt !== undefined && typeof r.startedAt !== "string")
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
	if (error instanceof WorkError && error.status >= 400 && error.status < 500)
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
	/** Releases per `actor bead`, and until when that actor does not get it. */
	readonly #cool = new Map<string, { n: number; until: number }>();
	/** Failed starts per bead. */
	readonly #failed = new Map<string, number>();
	/** Attempts per bead that ended without a result, with the last reasons. */
	readonly #attempts = new Map<string, { n: number; reasons: string[] }>();
	/** Per-queue lock: one claim pass at a time per queue in this replica. */
	readonly #locks = new Map<string, Promise<unknown>>();
	/** Recent decisions, oldest first; at most {@link DECISIONS_KEPT}. */
	readonly #decisions: DispatchDecision[] = [];
	/** Direct beads with an offer round running in this replica. */
	readonly #offering = new Set<string>();
	/** Direct beads nobody accepted: their address, next try, last note. */
	readonly #directWait = new Map<
		string,
		{ address: string; until: number; note: string }
	>();
	#stopped = false;
	/** One live process per runner (mm-210.79). */
	readonly sessions: RunnerSessions;

	constructor(options: DispatcherOptions) {
		this.#work = options.work;
		this.#opts = options;
		this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
		this.#actor = options.actor ?? "mastermind";
		this.#now = options.now ?? (() => new Date());
		this.sessions =
			options.sessions ??
			new RunnerSessions({ now: () => this.#now().getTime() });
	}

	/**
	 * A request of a runner process (next, status, offer answer): null when it
	 * may go on, else the `superseded` line. A process that wins answers the
	 * waiting `next` of the process it replaced.
	 */
	session(account: string, runner: string, claim: SessionClaim): string | null {
		const actor = `${account}/${runner}`;
		const v = this.sessions.check(actor, claim);
		if (!v.ok) return v.reason;
		if (typeof claim.session === "string" && claim.session)
			for (const list of [...this.#waiting.values()])
				for (const w of [...list]) {
					if (w.actor !== actor || w.session === claim.session) continue;
					const superseded = this.sessions.refusal(actor, w);
					if (!superseded) continue;
					this.#drop(w);
					this.#decide("decline", w.queue, "*", actor, superseded);
					w.resolve({ dispatch: null, superseded });
				}
		return null;
	}

	/** Number of `next` requests waiting, for tests and health. */
	waiting(queue?: string): number {
		if (queue !== undefined) return this.#waiting.get(queue)?.length ?? 0;
		let n = 0;
		for (const list of this.#waiting.values()) n += list.length;
		return n;
	}

	/** The waiters per queue and the recent decisions, for the operator. */
	debug(): DispatcherDebug {
		const waiters: DispatcherDebug["waiters"] = {};
		for (const [queue, list] of this.#waiting)
			waiters[queue] = list.map((w) => ({
				actor: w.actor,
				since: w.since,
				...(w.environments ? { environments: w.environments } : {}),
				...(w.session ? { session: w.session } : {}),
			}));
		return {
			waiters,
			decisions: this.#decisions.map((d) => ({ ...d })),
			sessions: this.sessions.duplicates(),
		};
	}

	async next(
		account: string,
		queue: string,
		req: NextRequest,
	): Promise<NextReply> {
		const runner = checkRunner(account, req);
		const actor = `${account}/${runner.id}`;
		this.#see({ kind: "next", runner, queue });
		const superseded = this.session(account, runner.id, runner);
		if (superseded) {
			this.#decide("decline", queue, "*", actor, superseded);
			// An old runner does not know the answer: do not let it spin.
			if (!runner.session) await this.#hold();
			return { dispatch: null, superseded };
		}
		const notReady = await this.#untilReady(actor, runner);
		if (notReady.length) {
			this.#decide(
				"decline",
				queue,
				"*",
				actor,
				`runner not ready: ${notReady.join("; ")}`,
			);
			return { dispatch: null, notReady };
		}
		const state = this.#state(runner, actor, queue);
		let wait: Promise<NextReply> | null = null;
		const reply = await this.#lock(queue, async () => {
			const ready = (
				await this.#dispatchable(queue, await this.#work.ready(queue))
			).filter((b) =>
				this.#eligible(actor, runner.environments, b, queue, runner),
			);
			const dispatch = await this.#take(state, actor, queue, ready);
			if (dispatch || this.#stopped || this.#waitMs <= 0) return { dispatch };
			// Registered under the lock: a ready signal cannot slip in between.
			wait = new Promise<NextReply>((resolve) => {
				const waiter: Waiter = {
					...state,
					...(runner.environments ? { environments: runner.environments } : {}),
					...(runner.session ? { session: runner.session } : {}),
					...(runner.version ? { version: runner.version } : {}),
					actor,
					queue,
					since: this.#now().toISOString(),
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
			const ready = await this.#dispatchable(
				queue,
				(await this.#work.ready(queue)).filter((b) => queueOf(b) === queue),
			);
			for (const bead of ready) {
				const current = this.#waiting.get(queue) ?? [];
				if (current.length === 0) break;
				const waiter = selectWaiter(
					bead,
					current.filter((w) =>
						this.#eligible(w.actor, w.environments, bead, queue, w),
					),
				);
				if (!waiter) continue;
				const dispatch = await this.#claim(bead, waiter.actor, queue, "woken");
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
		const output = workOutputOf(req.output) ?? undefined;
		const bead = await this.#held(beadId, actor);
		if (bead.status !== "closed")
			await this.#work
				.close(beadId, actor, summary, output)
				.catch((e) => Promise.reject(busError(e)));
		this.#forget(beadId);
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
		const key = `${actor} ${beadId}`;
		const n = (this.#cool.get(key)?.n ?? 0) + 1;
		const ms = RELEASE_BACKOFF_MS[n - 1] ?? Number.POSITIVE_INFINITY;
		this.#cool.set(key, { n, until: this.#now().getTime() + ms });
		let heldBack = bead.labels.includes(FAILED_START_LABEL);
		if (req.startFailed === true) {
			const failed = (this.#failed.get(beadId) ?? 0) + 1;
			this.#failed.set(beadId, failed);
			if (failed >= MAX_FAILED_STARTS && !heldBack) {
				await this.#holdBack(bead, failed, reason);
				heldBack = true;
			}
		}
		// failed:start already says why; one hold-back label is enough.
		await this.#attempt(bead, `released by ${actor}: ${reason}`, heldBack);
		this.#see({ kind: "done", actor, beadId });
		this.#signal(bead);
		return { ok: true };
	}

	/** Too many failed starts: label the bead and say why. */
	async #holdBack(bead: Bead, failed: number, reason: string): Promise<void> {
		try {
			await this.#work.comment(
				bead.id,
				this.#actor,
				`not dispatched: the agent failed to start ${failed} times; last: ${reason}. Reopen to try again.`,
			);
			await this.#work.setLabels(bead.id, this.#actor, [
				...bead.labels,
				FAILED_START_LABEL,
			]);
		} catch (error) {
			this.#opts.onError?.(error);
		}
	}

	/**
	 * Count one attempt that ended without a result. At the bead's maximum:
	 * label {@link NEEDS_HUMAN_LABEL} and a note with the last reasons.
	 */
	async #attempt(bead: Bead, reason: string, heldBack: boolean): Promise<void> {
		const prev = this.#attempts.get(bead.id);
		const n = (prev?.n ?? 0) + 1;
		const reasons = [...(prev?.reasons ?? []), reason].slice(
			-ATTEMPT_REASONS_KEPT,
		);
		this.#attempts.set(bead.id, { n, reasons });
		const max = this.#opts.maxAttempts?.(bead) ?? MAX_ATTEMPTS;
		if (n < max || heldBack || bead.labels.includes(NEEDS_HUMAN_LABEL)) return;
		try {
			await this.#work.comment(
				bead.id,
				this.#actor,
				`not dispatched: ${n} attempts ended without a result; last: ${reasons.join("; ")}. Reopen to try again.`,
			);
			await this.#work.setLabels(bead.id, this.#actor, [
				...bead.labels,
				NEEDS_HUMAN_LABEL,
			]);
		} catch (error) {
			this.#opts.onError?.(error);
		}
	}

	/** Drop the back-off, failure and attempt counts of a bead. */
	#forget(beadId: string): void {
		this.#failed.delete(beadId);
		this.#attempts.delete(beadId);
		for (const key of this.#cool.keys())
			if (key.endsWith(` ${beadId}`)) this.#cool.delete(key);
	}

	/** Give beads with a dead lease back to their queue. Returns their ids. */
	async sweep(): Promise<string[]> {
		const now = this.#now();
		const released: string[] = [];
		for (const bead of await this.#work.claimed()) {
			// Only dispatched work: a bead on a queue or sent to an address, held by an actor.
			if (!bead.assignee || !(queueOf(bead) || toOf(bead))) continue;
			if (leaseState(bead.lease, now) !== "expired") continue;
			try {
				await this.#work.release(bead.id, bead.assignee);
				released.push(bead.id);
				await this.#attempt(
					bead,
					`lease of ${bead.assignee} expired (last heartbeat ${bead.lease?.heartbeatAt ?? "none"})`,
					bead.labels.includes(FAILED_START_LABEL),
				);
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
		if (toOf(bead)) {
			if (columnOf(bead) === "ready" && !bead.assignee)
				await this.direct(bead.id);
			return;
		}
		if (bead.status !== "open") return;
		const rules = this.#opts.rules?.() ?? [];
		if (!target(bead, rules)) return;
		// The event's bead may be stale: a label change journals steps (old
		// queue removed, then new one added). Decide on the bead as it is now,
		// or a manual move to another queue gets undone.
		const current = await this.#work.get(bead.id);
		if (current.status !== "open" || queueOf(current) || toOf(current)) return;
		const t = target(current, rules);
		if (!t) return;
		// The label change is a new journal event; that one wakes the waiters
		// (or starts the offers).
		await this.#work.setLabels(bead.id, this.#actor, [
			...current.labels,
			"queue" in t ? queueLabel(t.queue) : toLabel(t.to),
		]);
	}

	/** Offer every waiting direct bead whose retry time has come. */
	async retryDirect(): Promise<void> {
		const now = this.#now().getTime();
		for (const bead of await this.#work.unrouted()) {
			const address = toOf(bead);
			if (!address || columnOf(bead) !== "ready" || bead.assignee) continue;
			const wait = this.#directWait.get(bead.id);
			if (wait && wait.address === address && now < wait.until) continue;
			await this.direct(bead.id).catch((e) => this.#opts.onError?.(e));
		}
	}

	/**
	 * One offer round for a direct bead: offer it to its address (each online
	 * runner of an account in turn) until one accepts. Nobody: mark it, say
	 * why, and wait (or move it to the rule's fallback queue).
	 */
	async direct(beadId: string): Promise<void> {
		if (this.#offering.has(beadId) || this.#stopped) return;
		this.#offering.add(beadId);
		try {
			await this.#offerRound(beadId);
		} finally {
			this.#offering.delete(beadId);
		}
	}

	async #offerRound(beadId: string): Promise<void> {
		const fresh = await this.#work.get(beadId);
		const address = toOf(fresh);
		if (
			!address ||
			queueOf(fresh) ||
			columnOf(fresh) !== "ready" ||
			fresh.assignee
		)
			return;
		const wait = this.#directWait.get(beadId);
		if (wait && wait.address === address && this.#now().getTime() < wait.until)
			return;
		const queue = directQueue(address);
		const [bead] = await this.#dispatchable(queue, [fresh]);
		if (!bead) return;
		const to = parseAddress(address);
		const lines: string[] = [];
		const offer = this.#opts.offer;
		if (!to)
			lines.push(
				`${address} is not an address (<account> or <account>/<runner>)`,
			);
		else if (!offer) lines.push("this Mastermind does not send direct offers");
		else {
			const runners = to.runner
				? [to.runner]
				: offerOrder(
						(this.#opts.runnersOf?.(to.account) ?? []).map((runner) => {
							const at = this.#served.get(`${to.account}/${runner}`);
							return { runner, ...(at ? { lastServedAt: at } : {}) };
						}),
					).map((r) => r.runner);
			if (runners.length === 0)
				lines.push(`no runner of ${to.account} is online`);
			const env = this.#envOf(bead, queue);
			const message: DirectOffer = {
				bead,
				queue,
				stage: "work",
				env,
				prompt: withInstructions(
					promptOf(bead, await this.#notes(beadId)),
					env,
				),
				address,
			};
			for (const runner of runners) {
				const actor = `${to.account}/${runner}`;
				const no = this.#ineligible(actor, undefined, bead, queue);
				if (no) {
					lines.push(`${actor}: ${no}`);
					continue;
				}
				let ex: OfferExchange;
				try {
					ex = await offer(to.account, runner, message);
				} catch (error) {
					ex = { kind: "declined", reason: `offer failed: ${error}` };
				}
				if (ex.kind !== "accepted") {
					const why =
						ex.kind === "offline"
							? "offline (nobody answers its offer subject; a runner older than mm-210.32 does not take offers)"
							: ex.kind === "timeout"
								? "no answer in time"
								: `declined: ${ex.reason}`;
					this.#decide("decline", queue, beadId, actor, `offer ${why}`);
					lines.push(`${actor}: ${why}`);
					continue;
				}
				if (ex.runner.account !== to.account || ex.runner.id !== runner) {
					ex.reply({ dispatch: null, reason: "answer from another runner" });
					lines.push(`${actor}: answered as another runner`);
					continue;
				}
				const superseded = this.session(to.account, runner, ex.runner);
				if (superseded) {
					ex.reply({ dispatch: null, reason: superseded });
					this.#decide("decline", queue, beadId, actor, `offer ${superseded}`);
					lines.push(`${actor}: ${superseded}`);
					continue;
				}
				// The process that answered must be the ready one (mm-210.79).
				const notThis = this.#ineligible(
					actor,
					undefined,
					bead,
					queue,
					ex.runner,
				);
				if (notThis) {
					ex.reply({ dispatch: null, reason: notThis });
					lines.push(`${actor}: ${notThis}`);
					continue;
				}
				let dispatch: Dispatch | null;
				try {
					dispatch = await this.#claim(bead, actor, queue, "offer");
				} catch (error) {
					ex.reply({ dispatch: null, reason: "the claim failed" });
					throw error;
				}
				if (!dispatch) {
					ex.reply({ dispatch: null, reason: "somebody else took the bead" });
					return;
				}
				ex.reply({ dispatch });
				this.#directWait.delete(beadId);
				await this.#note(
					bead,
					`sent to ${address}: ${[...lines, `${actor} accepted`].join("; ")}`,
					bead.labels.filter((l) => l !== NOT_ACCEPTED_LABEL),
				);
				return;
			}
		}
		const why = lines.join("; ");
		const fallback = fallbackOf(bead, address, this.#opts.rules?.() ?? []);
		if (fallback) {
			this.#directWait.delete(beadId);
			await this.#note(
				bead,
				`not accepted by ${address}: ${why}. Fallback: queue ${fallback}.`,
				[
					...bead.labels.filter(
						(l) => !l.startsWith(TO_LABEL_PREFIX) && l !== NOT_ACCEPTED_LABEL,
					),
					queueLabel(fallback),
				],
			);
			return;
		}
		const retryMs = this.#opts.retryMs ?? DIRECT_RETRY_MS;
		const note = `not accepted by ${address}: ${why}. It waits; offered again every ${Math.round(retryMs / 1000)} s.`;
		const marked = bead.labels.includes(NOT_ACCEPTED_LABEL);
		// Set before the writes: their journal events must not start a round.
		this.#directWait.set(beadId, {
			address,
			until: this.#now().getTime() + retryMs,
			note,
		});
		if (marked && wait?.note === note) return;
		await this.#note(
			bead,
			note,
			marked ? bead.labels : [...bead.labels, NOT_ACCEPTED_LABEL],
		);
	}

	/** A note on the bead, then its labels when they change. Errors go to onError. */
	async #note(bead: Bead, text: string, labels: string[]): Promise<void> {
		try {
			await this.#work.comment(bead.id, this.#actor, text);
			const same =
				labels.length === bead.labels.length &&
				labels.every((l, i) => l === bead.labels[i]);
			if (!same) await this.#work.setLabels(bead.id, this.#actor, labels);
		} catch (error) {
			this.#opts.onError?.(error);
		}
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
			const dispatch = await this.#claim(pick, actor, queue, "next");
			if (dispatch) return dispatch;
			left = left.filter((b) => b !== pick);
		}
	}

	/** Claim `bead` for `actor`; null when somebody else won it. */
	async #claim(
		bead: Bead,
		actor: string,
		queue: string,
		via: "next" | "woken" | "offer",
	): Promise<Dispatch | null> {
		const lost = (reason: string) => {
			this.#decide("decline", queue, bead.id, actor, reason);
			return null;
		};
		let claimed: Bead;
		try {
			const res = await this.#work.claim(bead.id, actor);
			// Same actor twice: the other request already got this bead.
			if (res.alreadyClaimed) return lost("another request of it got the bead");
			claimed = res.bead;
		} catch (error) {
			if (error instanceof AlreadyClaimed)
				return lost("lost the claim race (claimed by another)");
			if (error instanceof NotFound) return lost("bead not found at claim");
			throw error;
		}
		if (!claimed.lease) throw new Error(`claim of ${bead.id} has no lease`);
		this.#decide(
			"offer",
			queue,
			bead.id,
			actor,
			`claimed (${via === "next" ? "on next" : via === "woken" ? "waiter woken" : "offer accepted"}); lease until ${claimed.lease.expiresAt}`,
		);
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
		const env = this.#envOf(held, queue);
		return {
			bead: held,
			queue,
			actor,
			lease: claimed.lease,
			stage: "work",
			env,
			prompt: withInstructions(promptOf(held, await this.#notes(bead.id)), env),
		};
	}

	/** May `actor` take `bead` (bound environments, back-off, readiness)? Records why not. */
	#eligible(
		actor: string,
		environments: string[] | undefined,
		bead: Bead,
		queue: string,
		from: ProcessOf,
	): boolean {
		return this.#ineligible(actor, environments, bead, queue, from) === null;
	}

	/** Why `actor` may not take `bead`, recorded as a decision; null: it may. */
	#ineligible(
		actor: string,
		environments: string[] | undefined,
		bead: Bead,
		queue: string,
		/** The process that asks; absent: before an offer (no process yet). */
		from?: ProcessOf,
	): string | null {
		const no = (reason: string) => {
			this.#decide("decline", queue, bead.id, actor, reason);
			return reason;
		};
		if (!this.#bound(environments, bead, queue))
			return no(
				`environment not bound by the runner (bound: ${environments?.join(", ") || "none"})`,
			);
		const c = this.#cool.get(`${actor} ${bead.id}`);
		if (c && this.#now().getTime() < c.until)
			return no(
				Number.isFinite(c.until)
					? `back-off after release ${c.n} until ${new Date(c.until).toISOString()}`
					: `back-off after release ${c.n}: never again for this runner`,
			);
		const notReady = this.#notReady(actor, this.#envName(bead, queue), from);
		if (notReady.length) return no(`not ready: ${notReady.join("; ")}`);
		return null;
	}

	/** Why the runner `actor` is not ready (for `env`; null: runner-wide). Empty: it is. */
	#notReady(actor: string, env: string | null, from?: ProcessOf): string[] {
		const gate = this.#opts.readiness;
		if (!gate) return [];
		const i = actor.indexOf("/");
		const seen = gate(actor.slice(0, i), actor.slice(i + 1));
		return notReadyReasons(
			seen?.status ?? null,
			seen?.receivedAt ?? null,
			this.#now().getTime(),
			env,
			from,
		);
	}

	/** Wait `waitMs` (less on stop). */
	async #hold(): Promise<void> {
		const end = Date.now() + this.#waitMs;
		while (!this.#stopped && Date.now() < end)
			await Bun.sleep(Math.min(NOT_READY_POLL_MS, end - Date.now()));
	}

	/** Wait (up to `waitMs`) until the runner is ready; the reasons if it is not. */
	async #untilReady(actor: string, from: ProcessOf): Promise<string[]> {
		let reasons = this.#notReady(actor, null, from);
		const end = Date.now() + this.#waitMs;
		while (reasons.length && !this.#stopped && Date.now() < end) {
			await Bun.sleep(Math.min(NOT_READY_POLL_MS, end - Date.now()));
			reasons = this.#notReady(actor, null, from);
		}
		return reasons;
	}

	/** The environment name of a bead (resolved when it can be), or null. */
	#envName(bead: Bead, queue: string): string | null {
		const r = this.#opts.resolveEnv?.(bead, queue);
		return (r ? (r.ok ? r.env.name : undefined) : envNameOf(bead)) ?? null;
	}

	/** Add a decision; the same one again moves to the end with count + 1. */
	#decide(
		kind: DispatchDecision["kind"],
		queue: string,
		beadId: string,
		actor: string | undefined,
		reason: string,
	): void {
		const same = (d: DispatchDecision) =>
			d.kind === kind &&
			d.queue === queue &&
			d.beadId === beadId &&
			d.actor === actor &&
			d.reason === reason;
		const i = this.#decisions.findIndex(same);
		const count = i >= 0 ? (this.#decisions[i]?.count ?? 0) + 1 : 1;
		if (i >= 0) this.#decisions.splice(i, 1);
		this.#decisions.push({
			at: this.#now().toISOString(),
			kind,
			queue,
			beadId,
			...(actor !== undefined ? { actor } : {}),
			reason,
			count,
		});
		if (this.#decisions.length > DECISIONS_KEPT) this.#decisions.shift();
	}

	/** May a runner with these bound environments take `bead`? */
	#bound(
		environments: string[] | undefined,
		bead: Bead,
		queue: string,
	): boolean {
		if (!environments) return true;
		const r = this.#opts.resolveEnv?.(bead, queue);
		const name = r ? (r.ok ? r.env.name : undefined) : envNameOf(bead);
		return !name || environments.includes(name);
	}

	/** Resolution is pure: the claim resolves again rather than carry state. */
	#envOf(bead: Bead, queue: string): DispatchEnv {
		const r = this.#opts.resolveEnv?.(bead, queue);
		if (r?.ok) return r.env;
		return (this.#opts.env ?? defaultEnv)(bead, queue);
	}

	/**
	 * The beads of `ready` whose environment resolves. The others are marked
	 * once (label + note with the reason); a mark is removed when it resolves.
	 */
	async #dispatchable(queue: string, all: Bead[]): Promise<Bead[]> {
		const ready = all.filter((b) => {
			if (b.labels.includes(FAILED_START_LABEL)) {
				this.#decide(
					"decline",
					queue,
					b.id,
					undefined,
					`held back: label ${FAILED_START_LABEL} (reopen to try again)`,
				);
				return false;
			}
			if (b.labels.includes(NEEDS_HUMAN_LABEL)) {
				this.#decide(
					"decline",
					queue,
					b.id,
					undefined,
					`held back: label ${NEEDS_HUMAN_LABEL} (reopen to try again)`,
				);
				return false;
			}
			// Was held back and the label is gone: a human reopened it.
			if (
				(this.#failed.get(b.id) ?? 0) >= MAX_FAILED_STARTS ||
				(this.#attempts.get(b.id)?.n ?? 0) >=
					(this.#opts.maxAttempts?.(b) ?? MAX_ATTEMPTS)
			)
				this.#forget(b.id);
			return true;
		});
		const resolve = this.#opts.resolveEnv;
		if (!resolve) return ready;
		const ok: Bead[] = [];
		for (const bead of ready) {
			const r = resolve(bead, queue);
			const marked = bead.labels.includes(ENV_TRIAGE_LABEL);
			if (!r.ok)
				this.#decide(
					"decline",
					queue,
					bead.id,
					undefined,
					`environment does not resolve: ${r.reason}`,
				);
			try {
				if (r.ok) {
					if (!marked) {
						ok.push(bead);
						continue;
					}
					const labels = bead.labels.filter((l) => l !== ENV_TRIAGE_LABEL);
					await this.#work.setLabels(bead.id, this.#actor, labels);
					ok.push({ ...bead, labels });
				} else if (!marked) {
					await this.#work.comment(
						bead.id,
						this.#actor,
						`not dispatched: ${r.reason}`,
					);
					await this.#work.setLabels(bead.id, this.#actor, [
						...bead.labels,
						ENV_TRIAGE_LABEL,
					]);
				}
			} catch (error) {
				this.#opts.onError?.(error);
			}
		}
		return ok;
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
