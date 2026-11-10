// Open the routing store from config, in the background, retrying until NATS is up.
import { BdClient } from "@mastermind/beads";
import { connect, Store } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { CONFIG_BUCKET } from "./model.ts";
import type { RoutingBeads } from "./routes.ts";
import { RoutingStore } from "./store.ts";

export type RoutingNats =
	/** A connection someone else owns (auth's APP connection). */
	| { connection: Promise<NatsConnection> }
	/** Our own ws:// or wss:// connection (local dev without auth). */
	| { url: string; user?: string; pass?: string };

export type BackgroundRouting = {
	/** Null until the KV bucket is open. */
	store: () => RoutingStore | null;
	stop(): Promise<void>;
};

export function startRoutingInBackground(
	nats: RoutingNats,
	log: (line: string) => void = console.log,
): BackgroundRouting {
	let store: RoutingStore | null = null;
	let own: NatsConnection | null = null;
	let stopped = false;
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				if (!("connection" in nats) && !own)
					own = await connect({
						servers: nats.url,
						name: "mastermind-routing",
						user: nats.user,
						pass: nats.pass,
					});
				const nc = "connection" in nats ? await nats.connection : own;
				if (!nc) continue;
				store = new RoutingStore(await Store.open(nc, CONFIG_BUCKET));
				return;
			} catch (error) {
				if (stopped) return;
				const wait = Math.min(1_000 * 2 ** attempt, 60_000);
				log(`routing: start failed (${error}); retrying in ${wait}ms`);
				await Bun.sleep(wait);
			}
		}
	})();
	return {
		store: () => store,
		async stop() {
			stopped = true;
			await own?.drain().catch(() => {});
		},
	};
}

/** Bead reads and label writes through bd serve. */
export function bdRoutingBeads(baseUrl: string): RoutingBeads {
	const bd = new BdClient({ baseUrl });
	return {
		get: (id) => bd.get(id),
		setLabels: (id, actor, labels) => bd.update(id, actor, { labels }),
	};
}
