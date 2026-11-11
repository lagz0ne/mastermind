/**
 * The operator's remote doctor (mm-210.47): ask one runner to run its doctor
 * over NATS (`mm.u.<account>.r.<runner>.doctor`) and return its report. Steps
 * a-d always run; step e (a real agent) only when asked AND the runner was
 * started with --allow-remote-probe.
 */
import { BusError, request, SubjectError, subjects } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";

/** Steps a-d answer well within this. */
export const DOCTOR_TIMEOUT_MS = 45_000;
/** Step e waits up to 120 s for the agent. */
export const DEEP_DOCTOR_TIMEOUT_MS = 180_000;

export function remoteDoctor(nc: () => Promise<NatsConnection>) {
	return async (
		account: string,
		runner: string,
		deep: boolean,
	): Promise<unknown> => {
		let subject: string;
		try {
			subject = subjects.runnerDoctor(account, runner);
		} catch (error) {
			if (error instanceof SubjectError)
				throw new BusError("bad_request", error.message);
			throw error;
		}
		return request(
			await nc(),
			subject,
			{ deep },
			{ timeout: deep ? DEEP_DOCTOR_TIMEOUT_MS : DOCTOR_TIMEOUT_MS },
		);
	};
}
