/**
 * One live session per runner (mm-210.79). Each runner process makes a new
 * session id at start and sends it with `next`, its status and offer answers
 * (`RunnerInfo.session`, `RunnerDiagnostics.session`). Two processes of the
 * same `<account>/<runner>` (an old one still running after an update, or a
 * copied config on a second machine) must not both get work.
 *
 * Rule: the session that started last wins (ties: the larger id). A session
 * that lost is refused for good: it gets `superseded` and stops. A request
 * without a session (a runner older than mm-210.79) is refused while a session
 * of that runner is live. When the live session was not heard from for
 * `liveMs`, any session may take over (the process ended; a clock that went
 * back cannot lock a runner out).
 *
 * Prior art: the GitHub Actions runner refuses a second listener for the same
 * runner ("A session for this runner already exists"); Buildkite gives each
 * agent process its own session.
 *
 * In memory, per replica (v0 runs one).
 */
import { READINESS_FRESH_MS } from "@mastermind/core";

/** What a request says about its process. */
export type SessionClaim = { session?: unknown; startedAt?: unknown };

export type SessionVerdict =
	| { ok: true; tookOver: boolean }
	| { ok: false; reason: string };

/** A runner with two processes, for the debug view and /people. */
export type DuplicateSession = {
	actor: string;
	session: string;
	startedAt: string;
	/** The refused processes heard from within `liveMs`. */
	refused: {
		/** null: a runner without session id (older than mm-210.79). */
		session: string | null;
		startedAt: string | null;
		lastSeenAt: string;
		count: number;
	}[];
	/** One line for people. */
	line: string;
};

type Live = { session: string; startedAt: number; lastSeen: number };
type Loser = {
	session: string | null;
	startedAt: number | null;
	lastSeen: number;
	refused: number;
};

const LEGACY = "\u0000legacy";

const short = (s: string) => s.slice(0, 8);
const iso = (ms: number) => new Date(ms).toISOString();

function startOf(v: unknown): number {
	const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
	return Number.isFinite(ms) ? ms : 0;
}

export class RunnerSessions {
	readonly #live = new Map<string, Live>();
	readonly #losers = new Map<string, Map<string, Loser>>();
	readonly #liveMs: number;
	readonly #forgetMs: number;
	readonly #now: () => number;

	constructor(
		o: { liveMs?: number; forgetMs?: number; now?: () => number } = {},
	) {
		this.#liveMs = o.liveMs ?? READINESS_FRESH_MS;
		this.#forgetMs = o.forgetMs ?? 24 * 60 * 60 * 1000;
		this.#now = o.now ?? Date.now;
	}

	/** Record a request of `actor`'s process and say if it may go on. */
	check(actor: string, claim: SessionClaim): SessionVerdict {
		const now = this.#now();
		this.#forget(now);
		const session =
			typeof claim.session === "string" && claim.session ? claim.session : null;
		const live = this.#live.get(actor);
		const isLive = !!live && now - live.lastSeen <= this.#liveMs;
		if (session === null) {
			if (!isLive || !live) return { ok: true, tookOver: false };
			this.#lose(actor, null, null, now, 1);
			return { ok: false, reason: this.#reason(actor, live, null) };
		}
		if (live?.session === session) {
			live.lastSeen = now;
			return { ok: true, tookOver: false };
		}
		const lost = this.#losers.get(actor)?.get(session);
		if (lost && live) {
			lost.lastSeen = now;
			lost.refused++;
			return { ok: false, reason: this.#reason(actor, live, session) };
		}
		const startedAt = startOf(claim.startedAt);
		if (
			!live ||
			!isLive ||
			startedAt > live.startedAt ||
			(startedAt === live.startedAt && session > live.session)
		) {
			if (live)
				this.#lose(actor, live.session, live.startedAt, live.lastSeen, 0);
			this.#live.set(actor, { session, startedAt, lastSeen: now });
			return { ok: true, tookOver: !!live };
		}
		this.#lose(actor, session, startedAt, now, 1);
		return { ok: false, reason: this.#reason(actor, live, session) };
	}

	/**
	 * Why `claim` would be refused now (null: it would not), without
	 * recording anything. For waiters that a newer session replaces.
	 */
	refusal(actor: string, claim: SessionClaim): string | null {
		const live = this.#live.get(actor);
		if (!live) return null;
		const session =
			typeof claim.session === "string" && claim.session ? claim.session : null;
		return session === live.session ? null : this.#reason(actor, live, session);
	}

	/** Runners with a refused process heard from within `liveMs`. */
	duplicates(): DuplicateSession[] {
		const out: DuplicateSession[] = [];
		for (const actor of this.#losers.keys()) {
			const d = this.duplicate(actor);
			if (d) out.push(d);
		}
		return out.sort((a, b) => a.actor.localeCompare(b.actor));
	}

	/** The duplicate of one runner, or null. */
	duplicate(actor: string): DuplicateSession | null {
		const now = this.#now();
		const live = this.#live.get(actor);
		const losers = this.#losers.get(actor);
		if (!live || !losers) return null;
		const refused = [...losers.values()]
			.filter((l) => l.refused > 0 && now - l.lastSeen <= this.#liveMs)
			.map((l) => ({
				session: l.session,
				startedAt: l.startedAt === null ? null : iso(l.startedAt),
				lastSeenAt: iso(l.lastSeen),
				count: l.refused,
			}));
		if (!refused.length) return null;
		const who = refused
			.map((r) =>
				r.session === null
					? "an old runner without session id"
					: `session ${short(r.session)} (started ${r.startedAt})`,
			)
			.join(", ");
		return {
			actor,
			session: live.session,
			startedAt: iso(live.startedAt),
			refused,
			line: `duplicate session: another process of runner ${actor} asks for work and is refused (${who}); the live one is session ${short(live.session)} (started ${iso(live.startedAt)}). Stop the other one: mastermind-runner stop on its machine`,
		};
	}

	#reason(actor: string, live: Live, session: string | null): string {
		const tail =
			session === null
				? "this process sends no session id (a runner older than mm-210.79): stop it and update"
				: "this process gets no more work and stops";
		return `superseded: a newer process of runner ${actor} runs (session ${short(live.session)}, started ${iso(live.startedAt)}); ${tail}`;
	}

	#lose(
		actor: string,
		session: string | null,
		startedAt: number | null,
		lastSeen: number,
		refused: number,
	): void {
		let m = this.#losers.get(actor);
		if (!m) {
			m = new Map();
			this.#losers.set(actor, m);
		}
		const key = session ?? LEGACY;
		const l = m.get(key);
		if (l) {
			l.lastSeen = Math.max(l.lastSeen, lastSeen);
			l.refused += refused;
		} else m.set(key, { session, startedAt, lastSeen, refused });
	}

	#forget(now: number): void {
		for (const [actor, l] of this.#live)
			if (now - l.lastSeen > this.#forgetMs) this.#live.delete(actor);
		for (const [actor, m] of this.#losers) {
			for (const [k, l] of m)
				if (now - l.lastSeen > this.#forgetMs) m.delete(k);
			if (!m.size) this.#losers.delete(actor);
		}
	}
}
