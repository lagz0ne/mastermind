/**
 * Routing configuration: queues with their members, and the ordered rules that
 * put a bead on a queue. ONE document in JetStream KV (bucket `mm-config`, key
 * `routing`), written with compare-and-set by revision.
 *
 * Pure: validation and explanation. No I/O.
 */
import type { Bead } from "@mastermind/core";
import { isAddress, queueOf, TO_LABEL_PREFIX, toOf } from "@mastermind/core";
import { matches, type RoutingRule, type RuleMatch } from "@mastermind/router";

/** KV bucket and key of the routing document. */
export const CONFIG_BUCKET = "mm-config";
export const ROUTING_KEY = "routing";

export type Queue = {
	/** A single NATS subject token: letters, digits, '_' and '-'. */
	name: string;
	description: string;
	/** Account ids that may take work from this queue. */
	members: string[];
	/** At most this many beads of this queue held at once by one account. */
	maxPerAccount?: number;
	/** Default environment of its beads, when no env: label or rule names one. */
	environment?: string;
};

export type RoutingDoc = {
	queues: Queue[];
	rules: RoutingRule[];
	/** The queue of a bead that no rule matches. None: such a bead stays unrouted. */
	defaultQueue?: string;
};

export const EMPTY_ROUTING: RoutingDoc = { queues: [], rules: [] };

/** The document with the KV revision it was read at (0: never written). */
export type RoutingState = { doc: RoutingDoc; revision: number };

const QUEUE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MATCH_KEYS = new Set(["labels", "type", "maxPriority", "idPrefix"]);

export const isQueueName = (v: unknown): v is string =>
	typeof v === "string" && QUEUE_NAME.test(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check an untrusted document. Returns the clean document or the list of
 * problems (one line each, for a human). Unknown fields are dropped.
 */
export function validate(
	input: unknown,
): { ok: true; doc: RoutingDoc } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isObject(input))
		return { ok: false, errors: ["body must be an object"] };
	const rawQueues = Array.isArray(input.queues) ? input.queues : null;
	const rawRules = Array.isArray(input.rules) ? input.rules : null;
	if (!rawQueues) errors.push("queues must be a list");
	if (!rawRules) errors.push("rules must be a list");

	const queues: Queue[] = [];
	const names = new Set<string>();
	for (const [i, q] of (rawQueues ?? []).entries()) {
		const at = `queue ${i + 1}`;
		if (!isObject(q)) {
			errors.push(`${at}: must be an object`);
			continue;
		}
		if (!isQueueName(q.name)) {
			errors.push(
				`${at}: name must be 1-64 letters, digits, '_' or '-' (got ${JSON.stringify(q.name)})`,
			);
			continue;
		}
		if (names.has(q.name)) errors.push(`${at}: name ${q.name} is used twice`);
		names.add(q.name);
		const description = q.description ?? "";
		if (typeof description !== "string")
			errors.push(`${q.name}: description must be text`);
		const members = q.members ?? [];
		if (
			!Array.isArray(members) ||
			!members.every((m) => typeof m === "string" && ACCOUNT_ID.test(m))
		) {
			errors.push(`${q.name}: members must be account ids`);
		}
		const max = q.maxPerAccount;
		if (
			max !== undefined &&
			max !== null &&
			!(Number.isInteger(max) && (max as number) >= 1)
		) {
			errors.push(`${q.name}: maxPerAccount must be a whole number, 1 or more`);
		}
		const env = q.environment;
		if (env !== undefined && env !== null && env !== "" && !isQueueName(env))
			errors.push(`${q.name}: environment must be an environment name`);
		queues.push({
			name: q.name,
			description: typeof description === "string" ? description : "",
			members: Array.isArray(members)
				? [...new Set(members.filter((m) => typeof m === "string"))]
				: [],
			...(typeof max === "number" ? { maxPerAccount: max } : {}),
			...(isQueueName(env) ? { environment: env } : {}),
		});
	}

	const rules: RoutingRule[] = [];
	for (const [i, r] of (rawRules ?? []).entries()) {
		const at = `rule ${i + 1}`;
		if (!isObject(r) || !isObject(r.match)) {
			errors.push(`${at}: needs a match object and a queue or a to address`);
			continue;
		}
		const direct = r.to !== undefined && r.to !== null && r.to !== "";
		if (direct) {
			if (r.queue !== undefined && r.queue !== null && r.queue !== "")
				errors.push(`${at}: give a queue or a to address, not both`);
			if (!isAddress(r.to))
				errors.push(
					`${at}: to must be <account> or <account>/<runner> (got ${JSON.stringify(r.to)})`,
				);
			const fb = r.fallback;
			if (
				fb !== undefined &&
				fb !== null &&
				fb !== "" &&
				(typeof fb !== "string" || !names.has(fb))
			)
				errors.push(
					`${at}: fallback queue ${JSON.stringify(fb)} does not exist`,
				);
		} else if (typeof r.queue !== "string" || !names.has(r.queue)) {
			errors.push(`${at}: queue ${JSON.stringify(r.queue)} does not exist`);
		} else if (
			r.fallback !== undefined &&
			r.fallback !== null &&
			r.fallback !== ""
		)
			errors.push(`${at}: fallback is only for a to address`);
		const m = r.match;
		const match: RuleMatch = {};
		for (const k of Object.keys(m))
			if (!MATCH_KEYS.has(k)) errors.push(`${at}: unknown match field ${k}`);
		if (m.labels !== undefined) {
			if (
				!Array.isArray(m.labels) ||
				!m.labels.every((l) => typeof l === "string" && l.trim() !== "")
			)
				errors.push(`${at}: labels must be a list of labels`);
			else if (m.labels.length) match.labels = m.labels as string[];
		}
		if (m.type !== undefined) {
			if (typeof m.type !== "string" || m.type === "")
				errors.push(`${at}: type must be text`);
			else match.type = m.type;
		}
		if (m.maxPriority !== undefined) {
			if (
				!Number.isInteger(m.maxPriority) ||
				(m.maxPriority as number) < 0 ||
				(m.maxPriority as number) > 4
			)
				errors.push(`${at}: maxPriority must be 0 to 4`);
			else match.maxPriority = m.maxPriority as RuleMatch["maxPriority"];
		}
		if (m.idPrefix !== undefined) {
			if (typeof m.idPrefix !== "string" || m.idPrefix === "")
				errors.push(`${at}: idPrefix must be text`);
			else match.idPrefix = m.idPrefix;
		}
		const env = r.environment;
		if (env !== undefined && env !== null && env !== "" && !isQueueName(env))
			errors.push(`${at}: environment must be an environment name`);
		const environment = isQueueName(env) ? { environment: env } : {};
		rules.push(
			direct
				? {
						match,
						to: String(r.to),
						...(isQueueName(r.fallback) ? { fallback: r.fallback } : {}),
						...environment,
					}
				: { match, queue: String(r.queue), ...environment },
		);
	}

	const dq = input.defaultQueue;
	let defaultQueue: string | undefined;
	if (dq !== undefined && dq !== null && dq !== "") {
		if (typeof dq !== "string" || !names.has(dq))
			errors.push(`defaultQueue: queue ${JSON.stringify(dq)} does not exist`);
		else defaultQueue = dq;
	}

	return errors.length
		? { ok: false, errors }
		: {
				ok: true,
				doc: { queues, rules, ...(defaultQueue ? { defaultQueue } : {}) },
			};
}

/** Read a stored value leniently: a broken document routes nothing. */
export function parseStored(value: unknown): RoutingDoc {
	const v = validate(value);
	return v.ok ? v.doc : EMPTY_ROUTING;
}

export type RouteExplanation = {
	queue: string | null;
	/** The address of a direct bead (no queue); null otherwise. */
	to: string | null;
	/** Index of the winning rule; null when a queue label decided or nothing matched. */
	ruleIndex: number | null;
	why: string;
};

type RoutableBead = Pick<Bead, "id" | "type" | "priority" | "labels">;

function describe(match: RuleMatch): string {
	const parts: string[] = [];
	if (match.labels?.length) parts.push(`labels ${match.labels.join(", ")}`);
	if (match.type !== undefined) parts.push(`type ${match.type}`);
	if (match.maxPriority !== undefined)
		parts.push(`priority P${match.maxPriority} or more urgent`);
	if (match.idPrefix !== undefined)
		parts.push(`id starts with ${match.idPrefix}`);
	return parts.length ? parts.join(" and ") : "every bead";
}

/**
 * The rules as the router applies them: the document's rules, then a rule that
 * matches every bead and sends it to the default queue (when one is set).
 */
export function effectiveRules(doc: RoutingDoc): RoutingRule[] {
	return doc.defaultQueue
		? [...doc.rules, { match: {}, queue: doc.defaultQueue }]
		: doc.rules;
}

/**
 * Which queue a bead goes to, and why. Same decision as `route()` of the
 * router with {@link effectiveRules}.
 */
export function explain(bead: RoutableBead, doc: RoutingDoc): RouteExplanation {
	const current = queueOf(bead);
	if (current)
		return {
			queue: current,
			to: null,
			ruleIndex: null,
			why: `the bead has label queue:${current}; a queue label wins over the rules`,
		};
	const to = toOf(bead);
	if (to)
		return {
			queue: null,
			to,
			ruleIndex: null,
			why: `the bead has label ${TO_LABEL_PREFIX}${to}; it is offered to ${to} only`,
		};
	const i = doc.rules.findIndex((r) => matches(bead, r.match));
	if (i < 0)
		return doc.defaultQueue
			? {
					queue: doc.defaultQueue,
					to: null,
					ruleIndex: null,
					why: `no rule matches: the default queue ${doc.defaultQueue} takes it`,
				}
			: {
					queue: null,
					to: null,
					ruleIndex: null,
					why: "no rule matches: the bead stays unrouted",
				};
	const rule = doc.rules[i] as RoutingRule;
	const first = `rule ${i + 1} (${describe(rule.match)}) is the first that matches`;
	if (rule.to !== undefined)
		return {
			queue: null,
			to: rule.to,
			ruleIndex: i,
			why: `${first}: it is offered to ${rule.to} only${rule.fallback ? `; if nobody there accepts, queue ${rule.fallback}` : "; if nobody there accepts, it waits"}`,
		};
	return { queue: rule.queue, to: null, ruleIndex: i, why: first };
}

/**
 * The default environment of a bead on `queue`: the first matching rule that
 * routes to this queue and names one, else the queue's own. Null: none.
 * A direct bead's `queue` is `to:<address>`: the first matching rule to that
 * address, else its fallback queue's.
 */
export function defaultEnvironment(
	doc: RoutingDoc,
	bead: RoutableBead,
	queue: string,
): string | null {
	if (queue.startsWith(TO_LABEL_PREFIX)) {
		const address = queue.slice(TO_LABEL_PREFIX.length);
		const direct = doc.rules.filter(
			(r) => r.to === address && matches(bead, r.match),
		);
		const named = direct.find((r) => r.environment)?.environment;
		if (named) return named;
		const fb = direct.find((r) => r.fallback)?.fallback;
		return fb ? (queueNamed(doc, fb)?.environment ?? null) : null;
	}
	const rule = doc.rules.find(
		(r) => r.queue === queue && r.environment && matches(bead, r.match),
	);
	return rule?.environment ?? queueNamed(doc, queue)?.environment ?? null;
}

/** Queues that `account` is a member of. */
export function queuesOf(doc: RoutingDoc, account: string): string[] {
	return doc.queues
		.filter((q) => q.members.includes(account))
		.map((q) => q.name);
}

/** The queue, or null. */
export function queueNamed(doc: RoutingDoc, name: string): Queue | null {
	return doc.queues.find((q) => q.name === name) ?? null;
}
