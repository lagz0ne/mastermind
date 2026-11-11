/**
 * GET /api/debug/items/:id: one item, its timeline, and why it is or is not
 * dispatched (the routing decision and the runners that could take it).
 */
import type { Bead, BeadComment, BeadEvent } from "@mastermind/core";
import { columnOf, leaseState, queueOf } from "@mastermind/core";
import { matches, type RoutingRule, requirementsOf } from "@mastermind/router";
import type { RunnerEntry } from "../people/registry.ts";

export type ItemSources = {
	get(id: string): Promise<Bead>;
	journalOf(id: string): Promise<BeadEvent[]>;
	comments(id: string): Promise<BeadComment[]>;
};

type RoutingLike = {
	doc: {
		queues: { name: string; members: string[]; maxPerAccount?: number }[];
		rules: RoutingRule[];
	};
	revision: number;
};

export type RoutingDecision = {
	queue: string | null;
	/** label: the item has a queue: label; rule: rule `ruleIndex` matched; none. */
	by: "label" | "rule" | "none";
	ruleIndex: number | null;
	queueExists: boolean | null;
	members: string[] | null;
	requires: string[];
	/** Online runners that take this queue, and whether each can take the item. */
	runners: {
		runner: string;
		online: boolean;
		member: boolean | null;
		missing: string[];
		free: boolean | null;
	}[];
	/** Plain reasons the item is not offered now; empty when it should be. */
	blockers: string[];
};

export function decide(
	bead: Bead,
	routing: RoutingLike | null,
	runners: RunnerEntry[],
	now: Date,
): RoutingDecision {
	const labelled = queueOf(bead);
	const rules = routing?.doc.rules ?? [];
	const ruleIndex = labelled
		? -1
		: rules.findIndex((r) => matches(bead, r.match));
	const queue =
		labelled ?? (ruleIndex >= 0 ? (rules[ruleIndex]?.queue ?? null) : null);
	const open = !routing || routing.revision === 0;
	const q = queue
		? routing?.doc.queues.find((x) => x.name === queue)
		: undefined;
	const requires = requirementsOf(bead);
	const blockers: string[] = [];
	const column = columnOf(bead);
	if (bead.status !== "open")
		blockers.push(`status is ${bead.status}, only open items are offered`);
	if (bead.blocked) blockers.push("an open dependency blocks it");
	if (bead.assignee || leaseState(bead.lease, now) === "live")
		blockers.push(
			`held by ${bead.assignee ?? "?"} (lease ${leaseState(bead.lease, now)})`,
		);
	if (!queue)
		blockers.push(
			routing
				? "no queue: label and no rule matches (it stays unrouted)"
				: "no queue: label and routing is not readable",
		);
	else if (!open && !q) blockers.push(`queue ${queue} does not exist`);
	const onQueue = queue ? runners.filter((r) => r.queues.includes(queue)) : [];
	const view = onQueue.map((r) => {
		const missing = requires.filter((c) => !r.capabilities.includes(c));
		return {
			runner: `${r.account}/${r.runner}`,
			online: r.online,
			member: open ? null : q ? q.members.includes(r.account) : false,
			missing,
			free: r.capacity == null ? null : r.running.length < r.capacity,
		};
	});
	if (queue && column === "ready") {
		const able = view.filter(
			(r) =>
				r.online && r.member !== false && !r.missing.length && r.free !== false,
		);
		if (!onQueue.length) blockers.push(`no runner takes queue ${queue}`);
		else if (!able.length)
			blockers.push(
				`no online runner on ${queue} can take it now (offline, not a member, missing capability or full)`,
			);
	}
	return {
		queue,
		by: labelled ? "label" : ruleIndex >= 0 ? "rule" : "none",
		ruleIndex: ruleIndex >= 0 ? ruleIndex : null,
		queueExists: queue ? (open ? null : Boolean(q)) : null,
		members: q?.members ?? null,
		requires,
		runners: view,
		blockers,
	};
}
