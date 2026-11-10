import { expect, test } from "bun:test";
import { foldTimeline, stepTimeline } from "./timeline.ts";
import type { Bead, BeadEvent } from "./work.ts";

const at = "2026-11-10T08:00:00.000Z";
const lease = { expiresAt: "2026-11-10T08:05:00.000Z", heartbeatAt: at };
const open: Bead = {
	id: "mm-1",
	title: "t",
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: at,
	updatedAt: at,
};
const queued: Bead = { ...open, labels: ["queue:build"] };
const held: Bead = {
	...queued,
	status: "in_progress",
	assignee: "acc/r1",
	lease,
};

let seq = 0;
function ev(op: string, actor: string, bead?: Bead, extra = {}): BeadEvent {
	seq++;
	return { seq, at, op, beadId: "mm-1", actor, bead, ...extra };
}
function comment(author: string, text: string, bead: Bead): BeadEvent {
	return ev("comment", author, bead, {
		comment: { id: `c${seq}`, beadId: "mm-1", author, text, createdAt: at },
	});
}

test("the whole flow: created, routed, claimed, report, released, claimed, completed", () => {
	seq = 0;
	const events = [
		ev("create", "duke", open),
		ev("update", "mastermind", queued),
		ev("update", "acc/r1", held),
		comment("acc/r1", "cloned the repo", held),
		comment("duke", "use bun, not npm", held),
		comment("acc/r1", "released: env missing", held),
		ev("update", "acc/r1", queued),
		ev("update", "acc/r2", { ...held, assignee: "acc/r2" }),
		ev("close", "acc/r2", {
			...queued,
			status: "closed",
			assignee: "acc/r2",
			closeReason: "PR #4 merged",
		}),
	];
	const { entries, bead } = foldTimeline(events);
	expect(
		entries.map((e) => [e.kind, e.actor, e.text ?? e.queue ?? e.holder ?? ""]),
	).toEqual([
		["created", "duke", ""],
		["routed", "mastermind", "build"],
		["claimed", "acc/r1", "acc/r1"],
		["report", "acc/r1", "cloned the repo"],
		["note", "duke", "use bun, not npm"],
		["released", "acc/r1", "env missing"],
		["claimed", "acc/r2", "acc/r2"],
		["completed", "acc/r2", "PR #4 merged"],
	]);
	expect(entries[2]?.lease).toEqual(lease);
	expect(bead?.status).toBe("closed");
});

test("a release with no reason comment is the lease sweep; a human close is closed, reopen is reopened", () => {
	seq = 0;
	const { entries } = foldTimeline([
		ev("update", "acc/r1", held),
		ev("update", "acc/r1", queued),
		ev("close", "duke", { ...queued, status: "closed", closeReason: "dup" }),
		ev("update", "duke", queued),
	]);
	// The first event has no earlier state: it only says the bead changed.
	expect(entries.map((e) => [e.kind, e.text])).toEqual([
		["updated", undefined],
		["released", undefined],
		["closed", "dup"],
		["reopened", undefined],
	]);
	const after = foldTimeline([ev("update", "acc/r1", queued)], {
		bead: held,
		entries: [],
	});
	expect(after.entries).toMatchObject([{ kind: "released", holder: "acc/r1" }]);
	expect(after.entries[0]?.text).toBeUndefined();
});

test("label edits that keep the queue and heartbeats add nothing", () => {
	seq = 0;
	const state = { bead: held, entries: [] };
	const next = stepTimeline(
		state,
		ev("update", "acc/r1", { ...held, labels: ["queue:build", "x"] }),
	);
	expect(next.entries).toBe(state.entries);
});
