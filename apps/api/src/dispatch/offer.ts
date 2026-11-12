/**
 * The NATS side of direct delivery (mm-210.32).
 *
 *   Mastermind  request  mm.u.<account>.r.<runner>.offer         DirectOffer
 *               (reply subject mm.u.<account>.r.<runner>.offer.reply.<nonce>)
 *   runner      request  to that reply subject                    OfferAnswer
 *   Mastermind  reply    to the runner's inbox                    {result: OfferResult}
 *
 * The runner answers with a request, so that Mastermind can claim the bead
 * after an accept and send the dispatch back in the same exchange. A service
 * account may publish only under `mm.u.<account>.>`, so the reply subject sits
 * there (like the doctor's), not in an `_INBOX`.
 *
 * {@link Presence}: which runners are online, from their status messages and
 * `next` requests, for an account address.
 */
import {
	BusError,
	decode,
	encode,
	requestFailure,
	SubjectError,
	subjects,
} from "@mastermind/bus";
import type { DirectOffer, OfferAnswer } from "@mastermind/core";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { checkRunner, type OfferExchange } from "./dispatcher.ts";

/** How long a runner has to accept or decline. */
export const OFFER_TIMEOUT_MS = 5_000;

type Requester = Pick<NatsConnection, "request">;

/** Send one offer and read the runner's answer. */
export function natsOffer(nc: Requester, timeoutMs = OFFER_TIMEOUT_MS) {
	return async (
		account: string,
		runner: string,
		offer: DirectOffer,
	): Promise<OfferExchange> => {
		let subject: string;
		let reply: string;
		try {
			subject = subjects.runnerOffer(account, runner);
			reply = subjects.runnerOfferReply(
				account,
				runner,
				crypto.randomUUID().replaceAll("-", ""),
			);
		} catch (error) {
			if (error instanceof SubjectError)
				return { kind: "declined", reason: error.message };
			throw error;
		}
		let msg: Msg;
		try {
			msg = await nc.request(subject, encode(offer), {
				timeout: timeoutMs,
				noMux: true,
				reply,
			});
		} catch (error) {
			const f = requestFailure(error, subject);
			if (f.code === "unavailable") return { kind: "offline" };
			if (f.code === "timeout") return { kind: "timeout" };
			throw f;
		}
		const respond = (body: unknown) => {
			if (msg.reply) msg.respond(encode(body));
		};
		let answer: OfferAnswer;
		try {
			answer = decode<OfferAnswer>(msg.data);
		} catch {
			respond({
				error: { code: "bad_request", message: "answer is not JSON" },
			});
			return { kind: "declined", reason: "the answer is not JSON" };
		}
		if (answer?.accept === true) {
			try {
				const info = checkRunner(account, { runner: answer.runner });
				return {
					kind: "accepted",
					runner: info,
					reply: (result) => respond({ result }),
				};
			} catch (error) {
				const message =
					error instanceof BusError ? error.message : "bad runner";
				respond({ error: { code: "bad_request", message } });
				return { kind: "declined", reason: `bad accept: ${message}` };
			}
		}
		respond({ result: { dispatch: null } });
		const reason =
			typeof (answer as { reason?: unknown })?.reason === "string"
				? (answer as { reason: string }).reason.slice(0, 500)
				: "no reason given";
		return { kind: "declined", reason };
	};
}

/** Online runners per account, as this replica heard them. */
export class Presence {
	readonly #seen = new Map<string, Map<string, number>>();
	readonly #onlineMs: number;
	readonly #now: () => number;

	constructor(onlineMs = 90_000, now: () => number = Date.now) {
		this.#onlineMs = onlineMs;
		this.#now = now;
	}

	seen(account: string, runner: string): void {
		let m = this.#seen.get(account);
		if (!m) {
			m = new Map();
			this.#seen.set(account, m);
		}
		m.set(runner, this.#now());
	}

	/** Runner ids of `account` heard from within `onlineMs`, sorted. */
	online(account: string): string[] {
		const m = this.#seen.get(account);
		if (!m) return [];
		const now = this.#now();
		const out: string[] = [];
		for (const [runner, at] of m) {
			if (now - at <= this.#onlineMs) out.push(runner);
			else m.delete(runner);
		}
		return out.sort();
	}
}
