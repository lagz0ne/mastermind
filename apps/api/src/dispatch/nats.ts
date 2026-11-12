// Binds the Dispatcher to the bus subjects: every replica answers the adapter
// requests in queue group 'mastermind' and listens to every ready notice.
import {
	BEAD_VERBS,
	type BeadVerb,
	BusError,
	parseSubject,
	patterns,
	publish,
	SERVICE_QUEUE,
	Store,
	serve,
	subjects,
	subscribe,
} from "@mastermind/bus";
import type {
	BeadEvent,
	NextReply,
	NextRequest,
	RunnerDiagnostics,
} from "@mastermind/core";
import type { Msg, NatsConnection, Subscription } from "@nats-io/nats-core";
import {
	EMPTY_ENVIRONMENTS,
	ENVIRONMENTS_KEY,
	type EnvironmentsState,
	parseStored as parseEnvironments,
	resolveEnv,
} from "../environments/model.ts";
import { admit, reroute } from "../routing/enforce.ts";
import {
	CONFIG_BUCKET,
	defaultEnvironment,
	EMPTY_ROUTING,
	effectiveRules,
	parseStored,
	ROUTING_KEY,
	type RoutingState,
} from "../routing/model.ts";
import {
	Dispatcher,
	type DispatcherOptions,
	type RunnerStatusSeen,
} from "./dispatcher.ts";
import { natsOffer, OFFER_TIMEOUT_MS, Presence } from "./offer.ts";

export { CONFIG_BUCKET, ROUTING_KEY };

export type DispatchServiceOptions = Omit<
	DispatcherOptions,
	"notify" | "rules" | "resolveEnv" | "offer" | "runnersOf" | "readiness"
> & {
	/**
	 * Worker readiness gate (mm-210.59): work goes only to runners whose last
	 * status (mm.u.*.r.*.status) is ready, fresh and lists the environment.
	 * Default: on, unless the env var MM_READINESS_GATE is `off`.
	 */
	readinessGate?: boolean;
	/** How long a runner has to answer a direct offer. Default 5 s. */
	offerTimeoutMs?: number;
	/** Sweep dead leases this often. Default 30 s; 0 turns it off. */
	sweepMs?: number;
	/** Journal events (the board's JournalHub). Returns an unsubscribe. */
	events?: (listener: (event: BeadEvent) => void) => () => void;
	/**
	 * Load the routing document (queues, members, rules) from JetStream KV and
	 * follow changes: members are enforced on `next`, and each change reroutes
	 * open beads that have no queue. Default true.
	 */
	kvRules?: boolean;
	/**
	 * Resolve named environments (KV key `environments`; defaults from
	 * routing). Before the first save, beads without env:<name> dispatch the
	 * old way. Default true.
	 */
	kvEnvironments?: boolean;
};

export type DispatchService = {
	dispatcher: Dispatcher;
	/** "up" while the connection answers a round trip within 1 s. */
	probe(): Promise<"up" | "down">;
	stop(): Promise<void>;
};

/**
 * Watch the routing document in KV; `get` is always the latest value (null
 * until the first read). `onChange` runs after each value, the first included.
 */
async function watchRouting(
	nc: NatsConnection,
	onChange: (state: RoutingState) => void,
) {
	let state: RoutingState | null = null;
	const store = await Store.open<unknown>(nc, CONFIG_BUCKET);
	const first = await store.get(ROUTING_KEY);
	state = first
		? { doc: parseStored(first.value), revision: first.revision }
		: { doc: EMPTY_ROUTING, revision: 0 };
	const watch = await store.watch(ROUTING_KEY);
	void (async () => {
		for await (const e of watch) {
			state =
				e.op === "put"
					? { doc: parseStored(e.value), revision: e.revision }
					: { doc: EMPTY_ROUTING, revision: 0 };
			onChange(state);
		}
	})().catch(() => {});
	return { get: () => state, stop: () => watch.stop() };
}

/** Watch the environments document in KV; `get` is always the latest value. */
async function watchEnvironments(nc: NatsConnection) {
	const store = await Store.open<unknown>(nc, CONFIG_BUCKET);
	const first = await store.get(ENVIRONMENTS_KEY);
	let state: EnvironmentsState = first
		? { doc: parseEnvironments(first.value), revision: first.revision }
		: { doc: EMPTY_ENVIRONMENTS, revision: 0 };
	const watch = await store.watch(ENVIRONMENTS_KEY);
	void (async () => {
		for await (const e of watch) {
			state =
				e.op === "put"
					? { doc: parseEnvironments(e.value), revision: e.revision }
					: { doc: EMPTY_ENVIRONMENTS, revision: 0 };
		}
	})().catch(() => {});
	return { get: () => state, stop: () => watch.stop() };
}

export async function startDispatch(
	nc: NatsConnection,
	options: DispatchServiceOptions,
): Promise<DispatchService> {
	const {
		sweepMs = 30_000,
		events,
		kvRules = true,
		kvEnvironments = true,
		offerTimeoutMs = OFFER_TIMEOUT_MS,
		readinessGate = process.env.MM_READINESS_GATE !== "off",
		...rest
	} = options;
	// The last status of each runner, for the readiness gate.
	const statuses = new Map<string, RunnerStatusSeen>();
	const clock = () => (rest.now?.() ?? new Date()).getTime();
	// Online runners for account addresses: their status and `next` requests.
	const presence = new Presence();
	const onError = rest.onError;
	const { work } = rest;
	const actor = rest.actor ?? "mastermind";
	// Reroutes run one at a time; a change during a run triggers one more.
	let rerouting: Promise<unknown> = Promise.resolve();
	const routing = kvRules
		? await watchRouting(nc, (state) => {
				rerouting = rerouting.then(() =>
					reroute(work, state, actor, onError).catch((e) => onError?.(e)),
				);
			})
		: null;
	const environments = kvEnvironments ? await watchEnvironments(nc) : null;
	const dispatcher = new Dispatcher({
		...rest,
		observe: (seen) => {
			if (seen.kind === "next")
				presence.seen(seen.runner.account, seen.runner.id);
			rest.observe?.(seen);
		},
		offer: natsOffer(nc, offerTimeoutMs),
		...(readinessGate
			? {
					readiness: (account: string, runner: string) =>
						statuses.get(`${account}/${runner}`) ?? null,
				}
			: {}),
		runnersOf: (account) => presence.online(account),
		...(routing
			? {
					rules: () => {
						const doc = routing.get()?.doc;
						return doc ? effectiveRules(doc) : [];
					},
				}
			: {}),
		...(environments
			? {
					resolveEnv: (bead, queue) => {
						const envs = environments.get();
						const doc = routing?.get()?.doc;
						return resolveEnv(bead, envs.doc, {
							fallback: doc ? defaultEnvironment(doc, bead, queue) : null,
							open: envs.revision === 0,
						});
					},
				}
			: {}),
		notify: (notice) => publish(nc, subjects.ready(notice.queue), notice),
	});

	const bead = (msg: Msg, verb: BeadVerb) => {
		const s = parseSubject(msg.subject);
		if (s?.kind !== "bead" || s.verb !== verb)
			throw new BusError("bad_request", `not a ${verb} subject`);
		return s;
	};
	// Handlers get the raw request: the dispatcher validates every field.
	type Req = never;
	const subs: Subscription[] = [
		serve<NextRequest, NextReply>(
			nc,
			patterns.next,
			SERVICE_QUEUE,
			async (req, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind !== "next")
					throw new BusError("bad_request", "not a next subject");
				await admit(routing?.get() ?? null, s.account, s.queue, () =>
					work.claimed(),
				);
				return dispatcher.next(s.account, s.queue, req);
			},
			{ onError: (e) => onError?.(e) },
		),
		...BEAD_VERBS.map((verb) =>
			serve<Req, unknown>(
				nc,
				patterns.bead(verb),
				SERVICE_QUEUE,
				(req, msg) => {
					const s = bead(msg, verb);
					return dispatcher[verb](s.account, s.bead, req);
				},
				{ onError: (e) => onError?.(e) },
			),
		),
		subscribe<RunnerDiagnostics>(nc, patterns.runnerStatus, (d, msg) => {
			const s = parseSubject(msg.subject);
			if (
				s?.kind === "runnerStatus" &&
				typeof d?.runner === "string" &&
				d.runner &&
				// A process that a newer one replaced (mm-210.79): not its status.
				dispatcher.session(s.account, d.runner, d) === null
			) {
				presence.seen(s.account, d.runner);
				statuses.set(`${s.account}/${d.runner}`, {
					status: d,
					receivedAt: clock(),
				});
			}
		}),
		subscribe(nc, patterns.ready, (_notice, msg) => {
			const s = parseSubject(msg.subject);
			if (s?.kind === "ready")
				return dispatcher.ready(s.queue).catch((e) => onError?.(e));
		}),
	];

	const unsubscribe = events?.((event) => {
		dispatcher.onEvent(event).catch((e) => onError?.(e));
	});
	const sweeper =
		sweepMs > 0
			? setInterval(() => {
					dispatcher.sweep().catch((e) => onError?.(e));
					dispatcher.retryDirect().catch((e) => onError?.(e));
				}, sweepMs)
			: null;
	await nc.flush();

	return {
		dispatcher,
		async probe() {
			if (nc.isClosed()) return "down";
			const rtt = nc.rtt().then(
				() => "up" as const,
				() => "down" as const,
			);
			const timeout = Bun.sleep(1_000).then(() => "down" as const);
			return Promise.race([rtt, timeout]);
		},
		async stop() {
			if (sweeper) clearInterval(sweeper);
			unsubscribe?.();
			routing?.stop();
			environments?.stop();
			dispatcher.stop();
			for (const sub of subs) sub.unsubscribe();
		},
	};
}
