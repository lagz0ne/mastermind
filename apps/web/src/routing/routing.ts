/**
 * Routing in the browser: the document the api serves (GET/PUT /api/routing),
 * pure edits on it, and the api calls. Shapes mirror apps/api/src/routing.
 */

export type RuleMatch = {
	labels?: string[];
	type?: string;
	maxPriority?: 0 | 1 | 2 | 3 | 4;
	idPrefix?: string;
};
export type Rule = { match: RuleMatch; queue: string };
export type Queue = {
	name: string;
	description: string;
	members: string[];
	maxPerAccount?: number;
};
export type RoutingDoc = {
	queues: Queue[];
	rules: Rule[];
	/** The queue of a bead that no rule matches. None: it stays unrouted. */
	defaultQueue?: string;
};
export type Routing = RoutingDoc & { revision: number };
export type Explanation = {
	queue: string | null;
	ruleIndex: number | null;
	why: string;
};

export const QUEUE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Why a bead without a queue is not offered to anybody, in words. */
export const UNROUTED_REASON =
	"no rule matches; add a rule or move it to a queue";

// --- pure edits -----------------------------------------------------------

/** The document part of what the api returns (no revision). */
export function docOf(r: RoutingDoc): RoutingDoc {
	return {
		queues: r.queues,
		rules: r.rules,
		...(r.defaultQueue ? { defaultQueue: r.defaultQueue } : {}),
	};
}

/** Set the default queue; null (or an unknown name) removes it. */
export function setDefaultQueue(
	doc: RoutingDoc,
	name: string | null,
): RoutingDoc {
	const { defaultQueue: _, ...rest } = doc;
	return name && doc.queues.some((q) => q.name === name)
		? { ...rest, defaultQueue: name }
		: rest;
}

/**
 * The queue to suggest as default ("send all work to <queue>?"): when exactly
 * one queue exists, there are no rules and no default queue. Else null.
 */
export function suggestDefault(doc: RoutingDoc): string | null {
	if (doc.defaultQueue || doc.rules.length > 0 || doc.queues.length !== 1)
		return null;
	return doc.queues[0]?.name ?? null;
}

/** Move rule `i` by `delta` (-1 up, +1 down). Out of range: unchanged. */
export function moveRule(
	doc: RoutingDoc,
	i: number,
	delta: number,
): RoutingDoc {
	const j = i + delta;
	if (i < 0 || j < 0 || i >= doc.rules.length || j >= doc.rules.length)
		return doc;
	const rules = [...doc.rules];
	[rules[i], rules[j]] = [rules[j] as Rule, rules[i] as Rule];
	return { ...doc, rules };
}

export function setRule(doc: RoutingDoc, i: number, rule: Rule): RoutingDoc {
	return { ...doc, rules: doc.rules.map((r, k) => (k === i ? rule : r)) };
}

export function removeRule(doc: RoutingDoc, i: number): RoutingDoc {
	return { ...doc, rules: doc.rules.filter((_, k) => k !== i) };
}

export function addRule(doc: RoutingDoc): RoutingDoc {
	const queue = doc.queues[0]?.name ?? "";
	return { ...doc, rules: [...doc.rules, { match: {}, queue }] };
}

export function setQueue(
	doc: RoutingDoc,
	name: string,
	patch: Partial<Queue>,
): RoutingDoc {
	return {
		...doc,
		queues: doc.queues.map((q) => (q.name === name ? { ...q, ...patch } : q)),
	};
}

export function addQueue(doc: RoutingDoc, name: string): RoutingDoc {
	if (doc.queues.some((q) => q.name === name)) return doc;
	return {
		...doc,
		queues: [...doc.queues, { name, description: "", members: [] }],
	};
}

/** Remove a queue, the rules that send work to it, and it as the default. */
export function removeQueue(doc: RoutingDoc, name: string): RoutingDoc {
	return {
		queues: doc.queues.filter((q) => q.name !== name),
		rules: doc.rules.filter((r) => r.queue !== name),
		...(doc.defaultQueue && doc.defaultQueue !== name
			? { defaultQueue: doc.defaultQueue }
			: {}),
	};
}

export function addMember(
	doc: RoutingDoc,
	queue: string,
	account: string,
): RoutingDoc {
	const q = doc.queues.find((x) => x.name === queue);
	if (!q || q.members.includes(account)) return doc;
	return setQueue(doc, queue, { members: [...q.members, account] });
}

export function removeMember(
	doc: RoutingDoc,
	queue: string,
	account: string,
): RoutingDoc {
	const q = doc.queues.find((x) => x.name === queue);
	if (!q) return doc;
	return setQueue(doc, queue, {
		members: q.members.filter((m) => m !== account),
	});
}

/** Comma or space separated labels. */
export function parseLabels(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** One line for a rule's match, as the api explains it. */
export function describeMatch(match: RuleMatch): string {
	const parts: string[] = [];
	if (match.labels?.length) parts.push(`labels ${match.labels.join(", ")}`);
	if (match.type) parts.push(`type ${match.type}`);
	if (match.maxPriority !== undefined)
		parts.push(`priority P${match.maxPriority} or more urgent`);
	if (match.idPrefix) parts.push(`id starts with ${match.idPrefix}`);
	return parts.length ? parts.join(" and ") : "every bead";
}

/** Number of top-level differences between two documents (for "n unsaved changes"). */
export function changes(a: RoutingDoc, b: RoutingDoc): number {
	let n = 0;
	const qa = new Map(a.queues.map((q) => [q.name, JSON.stringify(q)]));
	const qb = new Map(b.queues.map((q) => [q.name, JSON.stringify(q)]));
	for (const [k, v] of qa) if (qb.get(k) !== v) n++;
	for (const k of qb.keys()) if (!qa.has(k)) n++;
	const len = Math.max(a.rules.length, b.rules.length);
	for (let i = 0; i < len; i++)
		if (JSON.stringify(a.rules[i]) !== JSON.stringify(b.rules[i])) n++;
	if ((a.defaultQueue ?? "") !== (b.defaultQueue ?? "")) n++;
	return n;
}

/**
 * "Try a bead" input: a bead id (`mm-214`), or a sketch such as
 * `bug P0 area:api ui` (a word P0-P4 is the priority, a word with ':' is a
 * label, the first other word is the type, other words are labels).
 */
export function parseTry(
	text: string,
):
	| { beadId: string }
	| { bead: { type?: string; priority: number; labels: string[] } }
	| null {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	if (words.length === 1 && /^[a-z][a-z0-9]*-[\w.]+$/i.test(words[0] ?? ""))
		return { beadId: words[0] as string };
	let type: string | undefined;
	let priority = 2;
	const labels: string[] = [];
	for (const w of words) {
		const p = /^p([0-4])$/i.exec(w);
		if (p) priority = Number(p[1]);
		else if (w.includes(":") || type !== undefined) labels.push(w);
		else type = w;
	}
	return { bead: { ...(type ? { type } : {}), priority, labels } };
}

// --- api ------------------------------------------------------------------

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly status: number,
		message: string,
		readonly body: Record<string, unknown> = {},
	) {
		super(message);
	}
}

type Fetch = typeof fetch;
let csrf: string | null = null;

async function readJson(res: Response): Promise<Record<string, unknown>> {
	return ((await res.json().catch(() => ({}))) ?? {}) as Record<
		string,
		unknown
	>;
}

async function call<T>(
	method: "GET" | "PUT" | "POST",
	path: string,
	body: unknown,
	fetcher: Fetch,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (method !== "GET") {
		if (!csrf) {
			const me = await fetcher("/api/auth/me", { credentials: "same-origin" });
			// Without auth (local dev) there is no CSRF token and none is needed.
			csrf = me.ok ? (((await me.json()) as { csrf?: string }).csrf ?? "") : "";
		}
		if (csrf) headers["x-csrf-token"] = csrf;
		headers["content-type"] = "application/json";
	}
	const res = await fetcher(path, {
		method,
		headers,
		credentials: "same-origin",
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
	const data = await readJson(res);
	if (res.status === 403) csrf = null;
	if (!res.ok)
		throw new ApiError(
			res.status,
			typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
			data,
		);
	return data as T;
}

export const getRouting = (fetcher: Fetch = fetch) =>
	call<Routing>("GET", "/api/routing", undefined, fetcher);

/** 409 throws an ApiError whose body.current is the newer document. */
export const saveRouting = (
	doc: RoutingDoc,
	revision: number,
	fetcher: Fetch = fetch,
) => call<Routing>("PUT", "/api/routing", { ...doc, revision }, fetcher);

export const tryRouting = (
	input: NonNullable<ReturnType<typeof parseTry>>,
	draft: RoutingDoc,
	fetcher: Fetch = fetch,
) =>
	call<Explanation>(
		"POST",
		"/api/routing/test",
		{ ...input, ...draft },
		fetcher,
	);

/** Manual override: put a bead on a queue (null: back to the rules). */
export const moveToQueue = (
	beadId: string,
	queue: string | null,
	fetcher: Fetch = fetch,
) =>
	call<{ bead: unknown }>(
		"POST",
		`/api/beads/${encodeURIComponent(beadId)}/queue`,
		{ queue },
		fetcher,
	);
