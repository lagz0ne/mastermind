// The work store on JetStream (@mastermind/work) behind the api's
// interfaces: Work (dispatcher), BoardSource (/api/board and /api/events),
// BeadsStore (/api/beads, /api/activity), RoutingBeads. The store opens in the background; until then every route
// answers 503 and the dispatcher waits.
import { connect } from "@mastermind/bus";
import type { BeadEvent, Probe } from "@mastermind/core";
import { NatsWork, type NatsWorkOptions } from "@mastermind/work";
import type { NatsConnection } from "@nats-io/nats-core";
import type { BeadsStore } from "../beads/routes.ts";
import type { BoardSource } from "../board/routes.ts";
import type { DispatchSeen } from "../dispatch/dispatcher.ts";
import { type DispatchService, startDispatch } from "../dispatch/nats.ts";
import type { DispatchNats } from "../dispatch/start.ts";
import type { Work } from "../dispatch/work.ts";
import type { RoutingBeads } from "../routing/routes.ts";

/** The store, typed as each interface it stands behind. */
export function natsWork(store: NatsWork): Work {
	return store;
}

export function natsBeadsStore(store: NatsWork): BeadsStore {
	return store;
}

export function natsRoutingBeads(store: NatsWork): RoutingBeads {
	return store;
}

/**
 * The board's journal source. An empty read waits up to `waitMs` for the next
 * event (the store's consumer pushes it), so the board's tail is not a poll.
 */
export function natsBoardSource(store: NatsWork, waitMs = 5_000): BoardSource {
	return {
		board: () => store.board(),
		head: () => store.head(),
		leases: () => store.leases(),
		async journalSince(seq) {
			const page = await store.journalSince(seq);
			if (page.length) return page;
			await store.waitFor(seq, waitMs);
			return store.journalSince(seq);
		},
	};
}

class NotReady extends Error {
	override name = "NotReady";
	constructor() {
		super("work store (nats) is not open yet");
	}
}

/** Calls through to the store once it is open; throws NotReady before. */
function late<T extends object>(get: () => T | null): T {
	return new Proxy({} as T, {
		get(_target, key) {
			// Not a thenable: awaiting the proxy must not call through.
			if (key === "then") return undefined;
			return (...args: unknown[]) => {
				const target = get();
				if (!target) return Promise.reject(new NotReady());
				const fn = (target as Record<PropertyKey, unknown>)[key];
				return (fn as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

export type NatsWorkConfig = {
	nats: DispatchNats;
	store?: NatsWorkOptions;
	/** What runners do (the runner registry of /people). */
	observe?: (seen: DispatchSeen) => void;
	onError?: (error: unknown) => void;
	log?: (line: string) => void;
	/** Retry n waits backoffMs * 2^n, at most 60 s. Default 1 s. */
	backoffMs?: number;
};

export type RunningNatsWork = {
	/** Null until open. */
	store(): NatsWork | null;
	board: BoardSource;
	beads: BeadsStore;
	routing: RoutingBeads;
	/** Health `work`: down until the store is open. */
	probe(): Promise<Probe>;
	/** Health `nats`: the dispatcher's probe, down until it serves. */
	dispatchProbe(): Promise<"up" | "down">;
	stop(): Promise<void>;
};

/** Open the store, then serve the dispatcher on it; a failed start retries with backoff. */
export function startNatsWork(config: NatsWorkConfig): RunningNatsWork {
	const log = config.log ?? console.log;
	const { nats } = config;
	const owned = !("connection" in nats);
	let nc: NatsConnection | null = null;
	let store: NatsWork | null = null;
	let dispatch: DispatchService | null = null;
	let stopped = false;
	const open = (): Promise<NatsConnection> =>
		"connection" in nats
			? nats.connection
			: connect({
					servers: nats.url,
					name: "mastermind-work",
					user: nats.user,
					pass: nats.pass,
				});
	void (async () => {
		for (let attempt = 1; !stopped; attempt++) {
			try {
				nc ??= await open();
				const started = performance.now();
				store ??= await NatsWork.open(nc, {
					onError: config.onError,
					...config.store,
				});
				if (stopped) break;
				log(
					`work: nats store open, head ${await store.head()} in ${Math.round(performance.now() - started)}ms`,
				);
				const s = store;
				dispatch = await startDispatch(nc, {
					work: natsWork(s),
					events: (listener: (event: BeadEvent) => void) =>
						s.subscribe(listener),
					observe: config.observe,
					onError: config.onError,
				});
				if (stopped) await dispatch.stop();
				else log("dispatch: serving on NATS (work store: nats)");
				return;
			} catch (error) {
				if (owned && !store) {
					await nc?.close().catch(() => {});
					nc = null;
				}
				if (stopped) return;
				const wait = Math.min(
					(config.backoffMs ?? 1_000) * 2 ** attempt,
					60_000,
				);
				log(`work: start failed (${error}); retrying in ${wait}ms`);
				await Bun.sleep(wait);
			}
		}
	})();
	let boardSource: BoardSource | null = null;
	const board = late<BoardSource>(() => {
		if (store) boardSource ??= natsBoardSource(store);
		return boardSource;
	});
	return {
		store: () => store,
		board,
		beads: late<BeadsStore>(() => store),
		routing: late<RoutingBeads>(() => store),
		probe: async () => (store ? store.probe() : "down"),
		dispatchProbe: async () => (dispatch ? dispatch.probe() : "down"),
		async stop() {
			stopped = true;
			await dispatch?.stop();
			store?.stop();
			if (owned) await nc?.drain().catch(() => {});
		},
	};
}
