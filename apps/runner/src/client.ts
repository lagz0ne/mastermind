/**
 * The runner's side of the dispatch subjects (`@mastermind/bus`,
 * `@mastermind/core` dispatch.ts). Every request goes under the account's
 * own prefix `mm.u.<account>.`; that is all the service account may publish.
 */
import {
	BusError,
	connect,
	request,
	subjects,
	subscribe,
} from "@mastermind/bus";
import type {
	Ack,
	CompleteRequest,
	Dispatch,
	HeartbeatReply,
	HeartbeatRequest,
	Lease,
	NextReply,
	NextRequest,
	ReadyNotice,
	ReleaseRequest,
	ReportRequest,
	RunnerInfo,
	WorkOutput,
} from "@mastermind/core";
import { errors, type NatsConnection } from "@nats-io/nats-core";

/** What the runner needs from Mastermind. The NATS client is one; tests use fakes. */
export interface MastermindClient {
	/** Long poll: a dispatch, or null when the queue had nothing in time. */
	next(queue: string): Promise<Dispatch | null>;
	heartbeat(beadId: string, actor: string): Promise<Lease>;
	report(beadId: string, actor: string, message: string): Promise<void>;
	/** `output`: the box output (branch, pull request) for the item. */
	complete(
		beadId: string,
		actor: string,
		summary: string,
		output?: WorkOutput,
	): Promise<void>;
	/**
	 * `startFailed`: the agent did not start (Mastermind backs off, then holds the bead).
	 * `hold`: the work is done but could not be delivered (Mastermind holds the bead for a human at once).
	 */
	release(
		beadId: string,
		actor: string,
		reason: string,
		opts?: { startFailed?: boolean; hold?: boolean },
	): Promise<void>;
	/** Mastermind says a queue has work. Returns an unsubscribe. */
	onReady(queue: string, listener: (n: ReadyNotice) => void): () => void;
}

/**
 * `next` must wait longer than the dispatcher's long poll (20 s by default),
 * or a bead claimed for this runner is lost until its lease dies.
 */
export const NEXT_TIMEOUT_MS = 30_000;
export const VERB_TIMEOUT_MS = 10_000;

/**
 * `runner`: what `next` says about the runner; a function is read on every
 * `next` (the ready environments change, mm-210.59).
 */
export function natsClient(
	nc: NatsConnection,
	runner: RunnerInfo | (() => RunnerInfo),
	opts: {
		nextTimeoutMs?: number;
		verbTimeoutMs?: number;
		/** Mastermind answered `next` with notReady (its readiness gate). */
		onNotReady?: (reasons: string[]) => void;
		/** A newer process of this runner runs (mm-210.79): this one should stop. */
		onSuperseded?: (line: string) => void;
	} = {},
): MastermindClient {
	const info = typeof runner === "function" ? runner : () => runner;
	const account = info().account;
	const timeout = opts.verbTimeoutMs ?? VERB_TIMEOUT_MS;
	const verb = <TReq, TRes>(
		beadId: string,
		v: "heartbeat" | "report" | "complete" | "release",
		body: TReq,
	) =>
		request<TReq, TRes>(nc, subjects.bead(account, beadId, v), body, {
			timeout,
		});
	return {
		async next(queue) {
			const reply = await request<NextRequest, NextReply>(
				nc,
				subjects.next(account, queue),
				{ runner: info() },
				{ timeout: opts.nextTimeoutMs ?? NEXT_TIMEOUT_MS },
			);
			if (reply?.superseded) opts.onSuperseded?.(reply.superseded);
			if (reply?.notReady?.length) opts.onNotReady?.(reply.notReady);
			return reply?.dispatch ?? null;
		},
		async heartbeat(beadId, actor) {
			const r = await verb<HeartbeatRequest, HeartbeatReply>(
				beadId,
				"heartbeat",
				{ actor },
			);
			return r.lease;
		},
		async report(beadId, actor, message) {
			await verb<ReportRequest, Ack>(beadId, "report", { actor, message });
		},
		async complete(beadId, actor, summary, output) {
			await verb<CompleteRequest, Ack>(beadId, "complete", {
				actor,
				summary,
				...(output ? { output } : {}),
			});
		},
		async release(beadId, actor, reason, o) {
			await verb<ReleaseRequest, Ack>(beadId, "release", {
				actor,
				reason,
				...(o?.startFailed ? { startFailed: true } : {}),
				...(o?.hold ? { hold: true } : {}),
			});
		},
		onReady(queue, listener) {
			const sub = subscribe<ReadyNotice>(nc, subjects.ready(queue), listener);
			return () => sub.unsubscribe();
		},
	};
}

/** Mastermind says the credential is revoked or was never valid. Do not retry. */
export class RevokedError extends Error {
	override name = "RevokedError";
}

export function isAuthFailure(error: unknown): boolean {
	if (error instanceof errors.AuthorizationError) return true;
	return (
		error instanceof Error && /authorization violation/i.test(error.message)
	);
}

/**
 * What Mastermind says about the credential. NATS answers "Authorization
 * Violation" both for a revoked credential and while Mastermind's auth callout
 * is not serving (every NATS restart), so only this HTTP answer decides.
 */
export type CredentialState = "valid" | "revoked" | "unknown";

/**
 * GET <mastermind>/api/auth/credential with the credential. 401 is `revoked`;
 * 200 is `valid`; anything else (no network, 5xx, 429, an older Mastermind
 * without the route) is `unknown`, and the runner keeps retrying.
 */
export async function checkCredential(
	mastermindUrl: string,
	credential: string,
	opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CredentialState> {
	try {
		const res = await (opts.fetch ?? fetch)(
			`${mastermindUrl.replace(/\/+$/, "")}/api/auth/credential`,
			{
				headers: { authorization: `Bearer ${credential}` },
				signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
			},
		);
		await res.body?.cancel().catch(() => {});
		if (res.status === 401) return "revoked";
		return res.ok ? "valid" : "unknown";
	} catch {
		return "unknown";
	}
}

/** A bus error that means the claim is gone: stop working on the bead. */
export function isLostClaim(error: unknown): boolean {
	return (
		error instanceof BusError &&
		(error.code === "conflict" || error.code === "not_found")
	);
}

export type Backoff = { minMs: number; maxMs: number };
export const BACKOFF: Backoff = { minMs: 500, maxMs: 30_000 };

/** Exponential backoff with full jitter in [min, min * 2^attempt], capped. */
export function backoffMs(
	attempt: number,
	b: Backoff = BACKOFF,
	random = Math.random,
): number {
	const cap = Math.min(b.maxMs, b.minMs * 2 ** Math.max(0, attempt - 1));
	return Math.round(b.minMs + random() * (cap - b.minMs));
}

export type ConnectRunnerOptions = {
	natsUrl: string;
	credential: string;
	inboxPrefix: string;
	name: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
	backoff?: Backoff;
	/**
	 * Asked after NATS refused the credential. Only `revoked` ends the runner;
	 * without it every auth error counts as temporary.
	 */
	verify?: () => Promise<CredentialState>;
	/** Called once when `verify` says `revoked` after the first connect. */
	onRevoked?: () => void;
	/** Ask `verify` at most this often while auth errors go on (ms). */
	verifyEveryMs?: number;
	/** Every NATS status change (disconnect, reconnect, ...), for diagnostics. */
	onStatus?: (type: string) => void;
};

/** While NATS refuses the credential, ask Mastermind at most every 30 s. */
export const VERIFY_EVERY_MS = 30_000;

/**
 * Dial out to NATS with the service account credential. The first connect
 * retries with backoff and jitter; after that the client reconnects by itself,
 * through auth errors too (a NATS restart: the auth callout is not serving for
 * a moment). An auth error only means "revoked" when `verify` says so: then the
 * first connect throws RevokedError, and a live connection calls `onRevoked`.
 */
export async function connectRunner(
	opts: ConnectRunnerOptions,
): Promise<NatsConnection> {
	const log = opts.log ?? (() => {});
	const verify = opts.verify ?? (async () => "unknown" as const);
	let revoked = false;
	let checking = false;
	let lastCheck = Number.NEGATIVE_INFINITY;
	const onAuthError = async () => {
		const now = performance.now();
		if (revoked || checking) return;
		if (now - lastCheck < (opts.verifyEveryMs ?? VERIFY_EVERY_MS)) return;
		checking = true;
		lastCheck = now;
		try {
			const state = await verify();
			log(`nats: credential refused; Mastermind says ${state}`);
			if (state === "revoked" && !revoked) {
				revoked = true;
				opts.onRevoked?.();
			}
		} finally {
			checking = false;
		}
	};
	for (let attempt = 1; ; attempt++) {
		if (opts.signal?.aborted) throw new Error("stopped");
		try {
			return await connect({
				servers: opts.natsUrl,
				name: opts.name,
				token: opts.credential,
				inboxPrefix: opts.inboxPrefix,
				timeout: 10_000,
				retryAuthErrors: true,
				onStatus: (s) => {
					opts.onStatus?.(s.type);
					if (s.type === "disconnect" || s.type === "reconnect")
						log(`nats: ${s.type}`);
					if (s.type === "error" && isAuthFailure(s.error))
						onAuthError().catch(() => {});
				},
			});
		} catch (error) {
			if (isAuthFailure(error)) {
				const state = await verify();
				if (state === "revoked")
					throw new RevokedError("Mastermind refused this runner's credential");
				const wait = backoffMs(attempt, opts.backoff);
				log(
					`nats: credential refused, Mastermind says ${state}; retrying in ${wait}ms`,
				);
				await Bun.sleep(wait);
				continue;
			}
			const wait = backoffMs(attempt, opts.backoff);
			log(`nats: connect failed (${error}); retrying in ${wait}ms`);
			await Bun.sleep(wait);
		}
	}
}
