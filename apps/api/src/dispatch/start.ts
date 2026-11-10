// Start the dispatcher from config, retrying until NATS answers.
import { BdClient, DoltReader, type SqlTag } from "@mastermind/beads";
import { connect } from "@mastermind/bus";
import type { BeadEvent } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { type DispatchService, startDispatch } from "./nats.ts";
import { beadsWork } from "./work.ts";

export type DispatchConfig = {
	/** ws:// or wss:// URL of NATS, in an account where the dispatcher may serve mm.u.*. */
	natsUrl: string;
	user?: string;
	pass?: string;
	/** Base URL of bd serve (writes). */
	bdUrl: string;
	/** Dolt (reads: claimed beads for the sweep). */
	dolt: SqlTag;
	events?: (listener: (event: BeadEvent) => void) => () => void;
	waitMs?: number;
	onError?: (error: unknown) => void;
};

export type RunningDispatch = {
	/** "down" until the dispatcher runs. */
	probe(): Promise<"up" | "down">;
	stop(): Promise<void>;
};

/** Connect and serve in the background; a failed start retries with backoff. */
export function runDispatch(config: DispatchConfig): RunningDispatch {
	let nc: NatsConnection | null = null;
	let svc: DispatchService | null = null;
	let stopped = false;
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				nc = await connect({
					servers: config.natsUrl,
					name: "mastermind-dispatch",
					user: config.user,
					pass: config.pass,
				});
				svc = await startDispatch(nc, {
					work: beadsWork(
						new BdClient({ baseUrl: config.bdUrl }),
						new DoltReader(config.dolt),
					),
					events: config.events,
					waitMs: config.waitMs,
					onError: config.onError,
				});
				if (stopped) await svc.stop();
				else console.log("dispatch: serving on NATS");
				return;
			} catch (error) {
				await nc?.close().catch(() => {});
				nc = null;
				const wait = Math.min(1_000 * 2 ** attempt, 60_000);
				console.error(
					`dispatch: start failed (${error}); retrying in ${wait}ms`,
				);
				await Bun.sleep(wait);
			}
		}
	})();
	return {
		probe: async () => (svc ? svc.probe() : "down"),
		async stop() {
			stopped = true;
			await svc?.stop();
			await nc?.drain().catch(() => {});
		},
	};
}
