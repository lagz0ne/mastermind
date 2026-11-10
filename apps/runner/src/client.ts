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
} from "@mastermind/core";
import { errors, type NatsConnection } from "@nats-io/nats-core";

/** What the runner needs from Mastermind. The NATS client is one; tests use fakes. */
export interface MastermindClient {
	/** Long poll: a dispatch, or null when the queue had nothing in time. */
	next(queue: string): Promise<Dispatch | null>;
	heartbeat(beadId: string, actor: string): Promise<Lease>;
	report(beadId: string, actor: string, message: string): Promise<void>;
	complete(beadId: string, actor: string, summary: string): Promise<void>;
	release(beadId: string, actor: string, reason: string): Promise<void>;
	/** Mastermind says a queue has work. Returns an unsubscribe. */
	onReady(queue: string, listener: (n: ReadyNotice) => void): () => void;
}

/**
 * `next` must wait longer than the dispatcher's long poll (20 s by default),
 * or a bead claimed for this runner is lost until its lease dies.
 */
export const NEXT_TIMEOUT_MS = 30_000;
export const VERB_TIMEOUT_MS = 10_000;

export function natsClient(
	nc: NatsConnection,
	runner: RunnerInfo,
	opts: { nextTimeoutMs?: number; verbTimeoutMs?: number } = {},
): MastermindClient {
	const account = runner.account;
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
				{ runner },
				{ timeout: opts.nextTimeoutMs ?? NEXT_TIMEOUT_MS },
			);
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
		async complete(beadId, actor, summary) {
			await verb<CompleteRequest, Ack>(beadId, "complete", {
				actor,
				summary,
			});
		},
		async release(beadId, actor, reason) {
			await verb<ReleaseRequest, Ack>(beadId, "release", { actor, reason });
		},
		onReady(queue, listener) {
			const sub = subscribe<ReadyNotice>(nc, subjects.ready(queue), listener);
			return () => sub.unsubscribe();
		},
	};
}

/** Mastermind refused the credential: revoked or never valid. Do not retry. */
export class RevokedError extends Error {
	override name = "RevokedError";
}

export function isAuthFailure(error: unknown): boolean {
	if (error instanceof errors.AuthorizationError) return true;
	return (
		error instanceof Error && /authorization violation/i.test(error.message)
	);
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
};

/**
 * Dial out to NATS with the service account credential. The first connect
 * retries with backoff and jitter; after that the client reconnects by itself.
 * An authorization failure is terminal: it throws RevokedError.
 */
export async function connectRunner(
	opts: ConnectRunnerOptions,
): Promise<NatsConnection> {
	const log = opts.log ?? (() => {});
	for (let attempt = 1; ; attempt++) {
		if (opts.signal?.aborted) throw new Error("stopped");
		try {
			return await connect({
				servers: opts.natsUrl,
				name: opts.name,
				token: opts.credential,
				inboxPrefix: opts.inboxPrefix,
				timeout: 10_000,
				onStatus: (s) => {
					if (s.type === "disconnect" || s.type === "reconnect")
						log(`nats: ${s.type}`);
				},
			});
		} catch (error) {
			if (isAuthFailure(error))
				throw new RevokedError("Mastermind refused this runner's credential");
			const wait = backoffMs(attempt, opts.backoff);
			log(`nats: connect failed (${error}); retrying in ${wait}ms`);
			await Bun.sleep(wait);
		}
	}
}
