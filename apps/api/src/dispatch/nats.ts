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
import type { BeadEvent, NextReply, NextRequest } from "@mastermind/core";
import type { RoutingRule } from "@mastermind/router";
import type { Msg, NatsConnection, Subscription } from "@nats-io/nats-core";
import { Dispatcher, type DispatcherOptions } from "./dispatcher.ts";

/** KV bucket and key of the routing rules (a RoutingRule[]). */
export const CONFIG_BUCKET = "mm-config";
export const RULES_KEY = "routing.rules";

export type DispatchServiceOptions = Omit<
	DispatcherOptions,
	"notify" | "rules"
> & {
	/** Sweep dead leases this often. Default 30 s; 0 turns it off. */
	sweepMs?: number;
	/** Journal events (the board's JournalHub). Returns an unsubscribe. */
	events?: (listener: (event: BeadEvent) => void) => () => void;
	/** Load routing rules from JetStream KV and follow changes. Default true. */
	kvRules?: boolean;
};

export type DispatchService = {
	dispatcher: Dispatcher;
	/** "up" while the connection answers a round trip within 1 s. */
	probe(): Promise<"up" | "down">;
	stop(): Promise<void>;
};

/** Watch the routing rules in KV; the getter is always the latest value. */
async function watchRules(nc: NatsConnection) {
	let rules: RoutingRule[] = [];
	const store = await Store.open<RoutingRule[]>(nc, CONFIG_BUCKET);
	const watch = await store.watch(RULES_KEY);
	void (async () => {
		for await (const e of watch) {
			rules = e.op === "put" && Array.isArray(e.value) ? e.value : [];
		}
	})().catch(() => {});
	return { get: () => rules, stop: () => watch.stop() };
}

export async function startDispatch(
	nc: NatsConnection,
	options: DispatchServiceOptions,
): Promise<DispatchService> {
	const { sweepMs = 30_000, events, kvRules = true, ...rest } = options;
	const onError = rest.onError;
	const rules = kvRules ? await watchRules(nc) : null;
	const dispatcher = new Dispatcher({
		...rest,
		rules: rules?.get,
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
			(req, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind !== "next")
					throw new BusError("bad_request", "not a next subject");
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
			rules?.stop();
			dispatcher.stop();
			for (const sub of subs) sub.unsubscribe();
		},
	};
}
