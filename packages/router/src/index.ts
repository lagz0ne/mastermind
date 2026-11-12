/**
 * Routing and distribution. Pure logic, no I/O.
 *
 * The model is PULL:
 * 1. {@link route} puts a bead on a queue (the `queue:<name>` label).
 * 2. A runner adapter asks for work on a queue; {@link selectBead} picks the bead.
 * 3. When a bead becomes ready while runners wait, {@link selectWaiter} picks the runner.
 */
import { type Bead, type Priority, queueOf, toOf } from "@mastermind/core";

/** All conditions that are set must hold. An empty match matches every bead. */
export type RuleMatch = {
	/** Every label must be on the bead. */
	labels?: string[];
	/** The bd issue type must be equal. */
	type?: string;
	/** The bead priority must be this value or more urgent (0 is the most urgent). */
	maxPriority?: Priority;
	/** The bead id must start with this text. */
	idPrefix?: string;
};

/**
 * A rule sends a bead either to a queue (broadcast: the first runner that
 * asks takes it) or to one address (direct: `<account>` or
 * `<account>/<runner>` is offered the bead and accepts or declines).
 */
export type RoutingRule = {
	match: RuleMatch;
	/** Default environment for the beads this rule routes (no env: label). */
	environment?: string;
} & (
	| { queue: string; to?: undefined; fallback?: undefined }
	| {
			to: string;
			queue?: undefined;
			/** When no runner of the address accepts: put the bead on this queue. */
			fallback?: string;
	  }
);

/** Where a bead goes: a queue, or one address. */
export type Target = { queue: string } | { to: string };

/** A runner that pulls work, as Mastermind sees it at decision time. */
export type RunnerState = {
	user: string;
	runner: string;
	queues: string[];
	capabilities: string[];
	capacity: number;
	running: number;
	/** ISO 8601. When this runner last got a bead. */
	lastServedAt?: string;
};

type RoutableBead = Pick<Bead, "id" | "type" | "priority" | "labels">;

export function matches(bead: RoutableBead, match: RuleMatch): boolean {
	if (match.labels && !match.labels.every((l) => bead.labels.includes(l)))
		return false;
	if (match.type !== undefined && bead.type !== match.type) return false;
	if (match.maxPriority !== undefined && bead.priority > match.maxPriority)
		return false;
	if (match.idPrefix !== undefined && !bead.id.startsWith(match.idPrefix))
		return false;
	return true;
}

/**
 * Where a bead goes. A bead that has a queue label keeps it, then one that
 * has a `to:` label keeps that. Else the first matching rule wins. Null means
 * not routed: the bead stays in triage.
 */
export function target(
	bead: RoutableBead,
	rules: readonly RoutingRule[],
): Target | null {
	const queue = queueOf(bead);
	if (queue) return { queue };
	const to = toOf(bead);
	if (to) return { to };
	const rule = rules.find((r) => matches(bead, r.match));
	if (!rule) return null;
	return rule.to !== undefined ? { to: rule.to } : { queue: rule.queue };
}

/** The queue of {@link target}; null for a direct bead or no match. */
export function route(
	bead: RoutableBead,
	rules: readonly RoutingRule[],
): string | null {
	const t = target(bead, rules);
	return t && "queue" in t ? t.queue : null;
}

/**
 * The fallback queue of a direct bead: the first matching rule that sends to
 * `address` and names one. Null: the bead waits.
 */
export function fallbackOf(
	bead: RoutableBead,
	address: string,
	rules: readonly RoutingRule[],
): string | null {
	return (
		rules.find((r) => r.to === address && r.fallback && matches(bead, r.match))
			?.fallback ?? null
	);
}

/** Order for offering a bead to the runners of one account: served least recently first, then id. */
export function offerOrder<
	R extends Pick<RunnerState, "runner" | "lastServedAt">,
>(runners: readonly R[]): R[] {
	return [...runners].sort(
		(a, b) =>
			servedAt(a) - servedAt(b) ||
			(a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0),
	);
}

/** A label `req:<capability>` means a runner must have that capability. */
export const REQUIREMENT_LABEL_PREFIX = "req:";

export function requirementsOf(bead: Pick<Bead, "labels">): string[] {
	const reqs = bead.labels
		.filter(
			(l) =>
				l.startsWith(REQUIREMENT_LABEL_PREFIX) &&
				l.length > REQUIREMENT_LABEL_PREFIX.length,
		)
		.map((l) => l.slice(REQUIREMENT_LABEL_PREFIX.length));
	return [...new Set(reqs)];
}

export function hasCapacity(runner: RunnerState): boolean {
	return runner.running < runner.capacity;
}

export function canRun(runner: RunnerState, bead: Pick<Bead, "labels">) {
	return requirementsOf(bead).every((c) => runner.capabilities.includes(c));
}

type SelectableBead = Pick<Bead, "id" | "priority" | "labels" | "createdAt">;

/** Priority first (0 first), then age (oldest first), then id. */
export function byPriorityThenAge(a: SelectableBead, b: SelectableBead) {
	return (
		a.priority - b.priority ||
		Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/**
 * The bead a runner gets when it asks for work on `queue`, or null.
 * Refuses (null) when the runner is not on the queue or is at capacity.
 * Only beads on `queue` are candidates.
 */
export function selectBead<B extends SelectableBead>(
	runner: RunnerState,
	queue: string,
	ready: readonly B[],
): B | null {
	if (!runner.queues.includes(queue) || !hasCapacity(runner)) return null;
	return (
		ready
			.filter((b) => queueOf(b) === queue && canRun(runner, b))
			.sort(byPriorityThenAge)[0] ?? null
	);
}

const NEVER = Number.NEGATIVE_INFINITY;

function servedAt(r: Pick<RunnerState, "lastServedAt">): number {
	return r.lastServedAt ? Date.parse(r.lastServedAt) : NEVER;
}

/**
 * The waiting runner that gets a bead that just became ready, or null.
 * The runner must be on the bead's queue, have capacity and have every
 * required capability. Among those, the USER served least recently wins
 * (a user's last service is the latest across all of their waiting runners).
 * Ties go to the runner served least recently, then to waiting order.
 */
export function selectWaiter<R extends RunnerState>(
	bead: Pick<Bead, "labels">,
	waiters: readonly R[],
): R | null {
	const queue = queueOf(bead);
	if (!queue) return null;

	const userServedAt = new Map<string, number>();
	for (const w of waiters) {
		userServedAt.set(
			w.user,
			Math.max(userServedAt.get(w.user) ?? NEVER, servedAt(w)),
		);
	}

	let best: R | null = null;
	for (const w of waiters) {
		if (!w.queues.includes(queue) || !hasCapacity(w) || !canRun(w, bead))
			continue;
		if (!best) {
			best = w;
			continue;
		}
		const wUser = userServedAt.get(w.user) ?? NEVER;
		const bestUser = userServedAt.get(best.user) ?? NEVER;
		if (
			wUser < bestUser ||
			(wUser === bestUser && servedAt(w) < servedAt(best))
		)
			best = w;
	}
	return best;
}
