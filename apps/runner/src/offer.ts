/**
 * The runner answers direct offers (mm-210.32):
 *
 *   Mastermind  request  mm.u.<account>.r.<runner>.offer   DirectOffer
 *   runner      request  to the offer's reply subject       OfferAnswer
 *   Mastermind  reply                                       OfferResult
 *
 * The answer is itself a request: on accept Mastermind claims the bead for
 * this runner and replies with the dispatch (or null and the reason). The
 * decision is the runner's own: a free slot and its routing (Runner.consider).
 */
import { request, subjects } from "@mastermind/bus";
import type {
	DirectOffer,
	Dispatch,
	OfferAnswer,
	OfferResult,
	RunnerInfo,
} from "@mastermind/core";
import type { Msg, NatsConnection, Subscription } from "@nats-io/nats-core";

/** Mastermind answers an accept after the claim: give it this long. */
export const ANSWER_TIMEOUT_MS = 15_000;

/** The part of the Runner that takes offers. */
export type OfferTaker = {
	consider(
		offer: DirectOffer,
	): { accept: true } | { accept: false; reason: string };
	takeOffer(dispatch: Dispatch): void;
	dropOffer(): void;
};

export type ServeOffersOptions = {
	runner: RunnerInfo;
	taker: OfferTaker;
	log?: (line: string) => void;
	answerTimeoutMs?: number;
};

/** Send the answer, then start the dispatch Mastermind returns. Exported for tests. */
export async function answerOffer(
	send: (answer: OfferAnswer) => Promise<OfferResult>,
	offer: DirectOffer,
	o: ServeOffersOptions,
): Promise<void> {
	const id = offer?.bead?.id ?? "?";
	let answer: OfferAnswer;
	try {
		const c = o.taker.consider(offer);
		answer = c.accept
			? { accept: true, runner: o.runner }
			: { accept: false, reason: c.reason };
	} catch (error) {
		answer = { accept: false, reason: `cannot read the offer: ${error}` };
	}
	if (!answer.accept) {
		o.log?.(`${id}: offer declined: ${answer.reason}`);
		await send(answer).catch(() => {});
		return;
	}
	let result: OfferResult;
	try {
		result = await send(answer);
	} catch (error) {
		o.taker.dropOffer();
		o.log?.(`${id}: accepted the offer, no dispatch came back: ${error}`);
		return;
	}
	if (!result?.dispatch) {
		o.taker.dropOffer();
		o.log?.(
			`${id}: accepted the offer, Mastermind gave no dispatch: ${result?.reason ?? "no reason"}`,
		);
		return;
	}
	o.log?.(`${id}: offer accepted (to ${offer.address})`);
	o.taker.takeOffer(result.dispatch);
}

/** Subscribe to this runner's offer subject. Returns the subscription. */
export function serveOffers(
	nc: NatsConnection,
	o: ServeOffersOptions,
): Subscription {
	return nc.subscribe(subjects.runnerOffer(o.runner.account, o.runner.id), {
		callback: (err, msg: Msg) => {
			if (err || !msg.reply) return;
			const reply = msg.reply;
			let offer: DirectOffer;
			try {
				offer = msg.json<DirectOffer>();
			} catch {
				return;
			}
			void answerOffer(
				(answer) =>
					request<OfferAnswer, OfferResult>(nc, reply, answer, {
						timeout: o.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
					}),
				offer,
				o,
			).catch((error) => o.log?.(`offer: failed: ${error}`));
		},
	});
}
