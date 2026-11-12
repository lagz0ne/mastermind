// Open the files buckets and serve the runner's file requests, in the
// background, retrying until NATS is up (mm-210.60).
import { connect } from "@mastermind/bus";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { BeadsStore } from "../beads/routes.ts";
import type { RoutingNats } from "../routing/start.ts";
import { serveFiles } from "./serve.ts";
import { type FilesConfig, ItemFiles } from "./service.ts";

export type BackgroundFiles = {
	/** Null until the inputs bucket is open. */
	files: () => ItemFiles | null;
	stop(): Promise<void>;
};

export function startFilesInBackground(
	nats: RoutingNats,
	beads: Pick<BeadsStore, "get" | "comment">,
	config: FilesConfig,
	opts: { log?: (line: string) => void; onError?: (e: unknown) => void } = {},
): BackgroundFiles {
	const log = opts.log ?? console.log;
	let files: ItemFiles | null = null;
	let own: NatsConnection | null = null;
	let subs: Subscription[] = [];
	let stopped = false;
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				if (!("connection" in nats) && !own)
					own = await connect({
						servers: nats.url,
						name: "mastermind-files",
						user: nats.user,
						pass: nats.pass,
					});
				const nc = "connection" in nats ? await nats.connection : own;
				if (!nc) continue;
				const f = new ItemFiles(nc, config);
				await f.inputs();
				if (stopped) return;
				subs = serveFiles(nc, f, beads, opts.onError);
				files = f;
				return;
			} catch (error) {
				if (stopped) return;
				const wait = Math.min(1_000 * 2 ** attempt, 60_000);
				log(`files: start failed (${error}); retrying in ${wait}ms`);
				await Bun.sleep(wait);
			}
		}
	})();
	return {
		files: () => files,
		async stop() {
			stopped = true;
			for (const s of subs) s.unsubscribe();
			await own?.drain().catch(() => {});
		},
	};
}
