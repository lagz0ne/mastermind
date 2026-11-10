// Start the dispatcher from config, retrying until it serves.
import { BdClient, DoltReader, type SqlTag } from "@mastermind/beads";
import { connect } from "@mastermind/bus";
import type { BeadEvent } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import type { DispatchSeen } from "./dispatcher.ts";
import { type BdCli, bdHeartbeat } from "./heartbeat.ts";
import { type DispatchService, startDispatch } from "./nats.ts";
import { beadsWork } from "./work.ts";

/**
 * Where the dispatcher's NATS connection comes from. It must be in the
 * account where adapters' subjects live (APP), so that it may serve mm.u.*.
 */
export type DispatchNats =
	/** A connection someone else owns, such as auth's APP connection. Not closed on stop. */
	| { connection: Promise<NatsConnection> }
	/** Our own ws:// or wss:// connection (local and dev, without auth). */
	| { url: string; user?: string; pass?: string };

export type DispatchConfig = {
	nats: DispatchNats;
	/** Base URL of bd serve (writes). */
	bdUrl: string;
	/** The bd CLI in bd serve's workspace: renews leases (bd serve cannot). */
	bdCli?: BdCli;
	/** Dolt (reads: claimed beads for the sweep). */
	dolt: SqlTag;
	events?: (listener: (event: BeadEvent) => void) => () => void;
	waitMs?: number;
	/** What runners do (the runner registry of /people). */
	observe?: (seen: DispatchSeen) => void;
	onError?: (error: unknown) => void;
	log?: (line: string) => void;
	/** Retry n waits backoffMs * 2^n, at most 60 s. Default 1 s. */
	backoffMs?: number;
};

export type RunningDispatch = {
	/** "down" until the dispatcher runs. */
	probe(): Promise<"up" | "down">;
	stop(): Promise<void>;
};

/** Serve in the background; a failed start retries with backoff. */
export function runDispatch(config: DispatchConfig): RunningDispatch {
	const log = config.log ?? console.log;
	const { nats } = config;
	const owned = !("connection" in nats);
	let nc: NatsConnection | null = null;
	let svc: DispatchService | null = null;
	let stopped = false;
	const open = (): Promise<NatsConnection> =>
		"connection" in nats
			? nats.connection
			: connect({
					servers: nats.url,
					name: "mastermind-dispatch",
					user: nats.user,
					pass: nats.pass,
				});
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				nc ??= await open();
				if (stopped) break;
				svc = await startDispatch(nc, {
					work: beadsWork(
						new BdClient({ baseUrl: config.bdUrl }),
						new DoltReader(config.dolt),
						config.bdCli && bdHeartbeat(config.bdCli),
					),
					events: config.events,
					waitMs: config.waitMs,
					observe: config.observe,
					onError: config.onError,
				});
				if (stopped) await svc.stop();
				else log("dispatch: serving on NATS");
				return;
			} catch (error) {
				// Our own connection is reopened; a shared one is kept, it reconnects itself.
				if (owned) {
					await nc?.close().catch(() => {});
					nc = null;
				}
				if (stopped) return;
				const wait = Math.min(
					(config.backoffMs ?? 1_000) * 2 ** attempt,
					60_000,
				);
				log(`dispatch: start failed (${error}); retrying in ${wait}ms`);
				await Bun.sleep(wait);
			}
		}
	})();
	return {
		probe: async () => (svc ? svc.probe() : "down"),
		async stop() {
			stopped = true;
			const running = svc;
			svc = null;
			await running?.stop();
			if (owned) await nc?.drain().catch(() => {});
		},
	};
}
