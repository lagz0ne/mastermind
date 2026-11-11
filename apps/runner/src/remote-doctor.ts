/**
 * The runner answers the operator's doctor requests (mm-210.47):
 *
 *   request  mm.u.<account>.r.<runner>.doctor   { deep?: boolean }
 *   reply    the DoctorReport (steps a-d; e only when allowed)
 *
 * Step e starts a real agent and costs tokens: remotely it runs ONLY when the
 * runner owner started the runner with --allow-remote-probe. One doctor at a
 * time; a second request while one runs gets `conflict`.
 */
import { BusError, serve, subjects } from "@mastermind/bus";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { DoctorReport } from "./doctor.ts";

export type DoctorRequest = { deep?: boolean };

export const REMOTE_PROBE_REFUSED =
	"skipped: not allowed by the runner owner (start the runner with --allow-remote-probe)";

export type RemoteDoctorOptions = {
	account: string;
	runnerId: string;
	/** The owner allows step e on request. */
	allowRemoteProbe: boolean;
	/** Run the doctor in this process. */
	run: (deep: boolean) => Promise<DoctorReport>;
	/** Every finished report (diagnostics lastDoctor). */
	onReport?: (r: DoctorReport) => void;
	log?: (line: string) => void;
};

/** Answer one doctor request; exported for tests. */
export function doctorHandler(o: RemoteDoctorOptions) {
	let running = false;
	return async (req: DoctorRequest | null): Promise<DoctorReport> => {
		if (running) throw new BusError("conflict", "a doctor is running");
		running = true;
		try {
			const want = req?.deep === true;
			const deep = want && o.allowRemoteProbe;
			o.log?.(
				`doctor: requested by the operator${want ? " (deep)" : ""}${want && !deep ? ", step e not allowed" : ""}`,
			);
			const report = await o.run(deep);
			if (want && !deep)
				for (const s of report.steps)
					if (s.id === "e")
						Object.assign(s, {
							status: "skip",
							detail: [REMOTE_PROBE_REFUSED],
						});
			o.onReport?.(report);
			return report;
		} finally {
			running = false;
		}
	};
}

/** Serve the runner's doctor subject. Returns the subscription. */
export function serveDoctor(
	nc: NatsConnection,
	o: RemoteDoctorOptions,
): Subscription {
	return serve<DoctorRequest | null, DoctorReport>(
		nc,
		subjects.runnerDoctor(o.account, o.runnerId),
		"doctor",
		doctorHandler(o),
		{ onError: (error) => o.log?.(`doctor: failed: ${error}`) },
	);
}
