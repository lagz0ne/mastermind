/**
 * HTTP side of routing. Every route needs a session (see auth/session.ts).
 *
 *   GET  /api/routing            -> {queues, rules, revision}
 *   PUT  /api/routing            {queues, rules, revision} -> {queues, rules, revision}
 *                                409 {error, current} when revision is stale
 *   POST /api/routing/test       {beadId} | {bead: {id?, type?, priority?, labels?}},
 *                                optional draft {queues, rules} (default: saved)
 *                                -> {queue, ruleIndex, why}
 *   POST /api/beads/:id/queue    {queue: string | null} -> {bead}
 *                                manual override: sets the label queue:<name>
 *                                (it wins over the rules); null removes it and
 *                                the rules decide again
 */

import {
	type Bead,
	type Priority,
	QUEUE_LABEL_PREFIX,
	queueLabel,
} from "@mastermind/core";
import { NotFound } from "@mastermind/work";
import type { RequireAccount } from "../auth/session.ts";
import { explain, isQueueName, queueNamed, validate } from "./model.ts";
import { type RoutingStore, StaleRevision } from "./store.ts";

/** The bead reads and writes that routing needs (the work store in production). */
export type RoutingBeads = {
	get(id: string): Promise<Bead>;
	/** Replaces the whole label set. */
	setLabels(id: string, actor: string, labels: string[]): Promise<Bead>;
};

export type RoutingRoutesOptions = {
	/** Null while NATS is not ready (or not configured): 503. */
	store: () => RoutingStore | null;
	/** Null without a work store: bead routes answer 503. */
	beads: RoutingBeads | null;
	requireAccount: RequireAccount;
	onError?: (error: unknown) => void;
};

type Req = Request & { params?: Record<string, string> };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: object = {}) =>
	json({ error, ...extra }, status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
	if (!req.headers.get("content-type")?.startsWith("application/json"))
		return null;
	try {
		const b = await req.json();
		return b && typeof b === "object" && !Array.isArray(b)
			? (b as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** A bead described in the request, for "try a bead". */
function sketch(
	raw: unknown,
): Pick<Bead, "id" | "type" | "priority" | "labels"> | null {
	if (!raw || typeof raw !== "object") return null;
	const b = raw as Record<string, unknown>;
	const labels = Array.isArray(b.labels)
		? b.labels.filter((l): l is string => typeof l === "string")
		: [];
	const p = Number(b.priority ?? 2);
	if (!Number.isInteger(p) || p < 0 || p > 4) return null;
	return {
		id: typeof b.id === "string" ? b.id : "",
		type: typeof b.type === "string" && b.type ? b.type : "task",
		priority: p as Priority,
		labels,
	};
}

export function routingRoutes(opts: RoutingRoutesOptions) {
	const guarded =
		(
			fn: (req: Req, account: string, store: RoutingStore) => Promise<Response>,
		) =>
		async (req: Req): Promise<Response> => {
			const who = await opts.requireAccount(req);
			if (who instanceof Response) return who;
			const store = opts.store();
			if (!store)
				return fail(503, "routing is not available: NATS is not ready");
			try {
				return await fn(req, who, store);
			} catch (error) {
				if (error instanceof NotFound) return fail(404, "no such bead");
				opts.onError?.(error);
				return fail(500, "internal error");
			}
		};

	return {
		"/api/routing": {
			GET: guarded(async (_req, _account, store) => {
				const { doc, revision } = await store.read();
				return json({ ...doc, revision });
			}),
			PUT: guarded(async (req, _account, store) => {
				const b = await body(req);
				if (!b) return fail(400, "JSON body required");
				const revision = b.revision;
				if (!Number.isInteger(revision) || (revision as number) < 0)
					return fail(400, "revision required (0 for the first write)");
				const v = validate(b);
				if (!v.ok) return fail(400, v.errors.join("; "), { errors: v.errors });
				try {
					const saved = await store.write(v.doc, revision as number);
					return json({ ...saved.doc, revision: saved.revision });
				} catch (error) {
					if (error instanceof StaleRevision)
						return fail(
							409,
							"somebody else saved routing first; reload, then apply your change again",
							{
								current: {
									...error.current.doc,
									revision: error.current.revision,
								},
							},
						);
					throw error;
				}
			}),
		},
		"/api/routing/test": {
			POST: guarded(async (req, _account, store) => {
				const b = await body(req);
				let bead: Pick<Bead, "id" | "type" | "priority" | "labels"> | null =
					null;
				if (typeof b?.beadId === "string" && b.beadId) {
					const beads = opts.beads;
					if (!beads) return fail(503, "beads unconfigured: set NATS");
					bead = await beads.get(b.beadId);
				} else {
					bead = sketch(b?.bead);
				}
				if (!bead)
					return fail(400, "beadId or bead {type, priority, labels} required");
				// A draft from the editor (unsaved), else the saved document.
				if (b && Array.isArray(b.rules)) {
					const draft = validate(b);
					if (!draft.ok)
						return fail(400, draft.errors.join("; "), { errors: draft.errors });
					return json(explain(bead, draft.doc));
				}
				const { doc } = await store.read();
				return json(explain(bead, doc));
			}),
		},
		"/api/beads/:id/queue": {
			POST: guarded(async (req, account, store) => {
				const beads = opts.beads;
				if (!beads) return fail(503, "beads unconfigured: set NATS");
				const b = await body(req);
				if (!b || !("queue" in b))
					return fail(400, "queue required (a name or null)");
				const queue = b.queue;
				if (queue !== null) {
					if (!isQueueName(queue)) return fail(400, "bad queue name");
					const { doc } = await store.read();
					if (!queueNamed(doc, queue)) return fail(400, `no queue ${queue}`);
				}
				const id = req.params?.id ?? "";
				const bead = await beads.get(id);
				const labels = bead.labels.filter(
					(l) => !l.startsWith(QUEUE_LABEL_PREFIX),
				);
				if (queue !== null) labels.push(queueLabel(queue));
				const updated = await beads.setLabels(id, account, labels);
				return json({ bead: updated });
			}),
		},
	};
}
