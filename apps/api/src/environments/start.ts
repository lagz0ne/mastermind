// Open the environments store from config, in the background, retrying until NATS is up.
import { connect, Store } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { CONFIG_BUCKET } from "../routing/model.ts";
import type { RoutingNats } from "../routing/start.ts";
import { EnvironmentStore } from "./store.ts";

export type BackgroundEnvironments = {
	/** Null until the KV bucket is open. */
	store: () => EnvironmentStore | null;
	stop(): Promise<void>;
};

export function startEnvironmentsInBackground(
	nats: RoutingNats,
	log: (line: string) => void = console.log,
): BackgroundEnvironments {
	let store: EnvironmentStore | null = null;
	let own: NatsConnection | null = null;
	let stopped = false;
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				if (!("connection" in nats) && !own)
					own = await connect({
						servers: nats.url,
						name: "mastermind-environments",
						user: nats.user,
						pass: nats.pass,
					});
				const nc = "connection" in nats ? await nats.connection : own;
				if (!nc) continue;
				store = new EnvironmentStore(await Store.open(nc, CONFIG_BUCKET));
				return;
			} catch (error) {
				if (stopped) return;
				const wait = Math.min(1_000 * 2 ** attempt, 60_000);
				log(`environments: start failed (${error}); retrying in ${wait}ms`);
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
