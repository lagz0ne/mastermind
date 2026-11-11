/**
 * The operator's remote doctor (mm-210.47): ask one runner to run its doctor
 * over NATS (`mm.u.<account>.r.<runner>.doctor`) and return its report. Steps
 * a-d always run; step e (a real agent) only when asked AND the runner was
 * started with --allow-remote-probe.
 *
 * A service account may publish only under `mm.u.<account>.>`, so the reply
 * subject is `...doctor.reply.<nonce>` there, not an `_INBOX`.
 */
import {
	BusError,
	decode,
	encode,
	requestFailure,
	SubjectError,
	subjects,
	unwrap,
} from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";

/** Steps a-d answer well within this. */
export const DOCTOR_TIMEOUT_MS = 45_000;
/** Step e waits up to 120 s for the agent. */
export const DEEP_DOCTOR_TIMEOUT_MS = 180_000;

type Requester = Pick<NatsConnection, "request">;

export function remoteDoctor(nc: () => Promise<Requester>) {
	return async (
		account: string,
		runner: string,
		deep: boolean,
	): Promise<unknown> => {
		let subject: string;
		let reply: string;
		try {
			subject = subjects.runnerDoctor(account, runner);
			reply = subjects.runnerDoctorReply(
				account,
				runner,
				crypto.randomUUID().replaceAll("-", ""),
			);
		} catch (error) {
			if (error instanceof SubjectError)
				throw new BusError("bad_request", error.message);
			throw error;
		}
		const conn = await nc();
		let data: Uint8Array;
		try {
			const msg = await conn.request(subject, encode({ deep }), {
				timeout: deep ? DEEP_DOCTOR_TIMEOUT_MS : DOCTOR_TIMEOUT_MS,
				noMux: true,
				reply,
			});
			data = msg.data;
		} catch (error) {
			throw requestFailure(error, subject);
		}
		return unwrap(decode(data));
	};
}
