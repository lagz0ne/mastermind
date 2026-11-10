// In-memory Work with bd's claim semantics, for tests.
import { AlreadyClaimed, BdError, NotFound } from "@mastermind/beads";
import { type Bead, queueLabel } from "@mastermind/core";
import type { Work } from "./work.ts";

export const LEASE_MS = 5 * 60_000;

export type FakeWork = Work & {
	beads: Map<string, Bead>;
	comments: { id: string; actor: string; text: string }[];
	add(bead: Partial<Bead> & { id: string }, queue?: string): Bead;
	/** Wait this long inside claim, to widen race windows. */
	claimDelayMs: number;
};

const problem = (status: number, code: string, extra = {}) => ({
	status,
	title: code,
	code,
	...extra,
});

export function fakeWork(now: () => Date = () => new Date()): FakeWork {
	const beads = new Map<string, Bead>();
	const comments: FakeWork["comments"] = [];
	const find = (id: string): Bead => {
		const b = beads.get(id);
		if (!b) throw new NotFound(problem(404, "not_found"));
		return b;
	};
	const copy = (b: Bead): Bead => structuredClone(b);
	const fake: FakeWork = {
		beads,
		comments,
		claimDelayMs: 0,
		add(input, queue) {
			const at = now().toISOString();
			const bead: Bead = {
				title: input.id,
				status: "open",
				priority: 2,
				type: "task",
				labels: [],
				blocked: false,
				createdAt: at,
				updatedAt: at,
				...input,
			};
			if (queue) bead.labels = [...bead.labels, queueLabel(queue)];
			beads.set(bead.id, bead);
			return bead;
		},
		async ready(queue) {
			return [...beads.values()]
				.filter(
					(b) =>
						b.status === "open" &&
						!b.blocked &&
						b.labels.includes(queueLabel(queue)),
				)
				.map(copy);
		},
		async get(id) {
			return copy(find(id));
		},
		async claim(id, actor) {
			if (fake.claimDelayMs) await Bun.sleep(fake.claimDelayMs);
			const b = find(id);
			if (b.status === "in_progress" && b.assignee && b.assignee !== actor)
				throw new AlreadyClaimed(
					problem(409, "already_claimed", { assignee: b.assignee }),
				);
			const already = b.status === "in_progress" && b.assignee === actor;
			const t = now();
			b.status = "in_progress";
			b.assignee = actor;
			b.lease = {
				expiresAt: new Date(t.getTime() + LEASE_MS).toISOString(),
				heartbeatAt: t.toISOString(),
			};
			b.updatedAt = t.toISOString();
			// bd omits labels from the claim reply.
			return { bead: { ...copy(b), labels: [] }, alreadyClaimed: already };
		},
		async release(id) {
			const b = find(id);
			if (b.status !== "in_progress")
				throw new BdError(409, "not_releasable", "holds no claim");
			b.status = "open";
			delete b.assignee;
			delete b.lease;
			return copy(b);
		},
		async close(id, _actor, _reason) {
			const b = find(id);
			b.status = "closed";
			b.closedAt = now().toISOString();
			return copy(b);
		},
		async comment(id, actor, text) {
			find(id);
			comments.push({ id, actor, text });
			return {};
		},
		async setLabels(id, _actor, labels) {
			const b = find(id);
			b.labels = labels;
			return copy(b);
		},
		async claimed() {
			return [...beads.values()]
				.filter((b) => b.status === "in_progress")
				.map(copy);
		},
	};
	return fake;
}
