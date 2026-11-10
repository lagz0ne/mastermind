import { expect, test } from "bun:test";
import type { Bead, BeadDetail, BeadEvent } from "@mastermind/core";
import { foldAfter } from "./detail.ts";

const at = "2026-11-10T08:00:00.000Z";
const bead: Bead = {
	id: "mm-1",
	title: "t",
	status: "open",
	priority: 2,
	type: "task",
	labels: ["queue:build"],
	blocked: false,
	createdAt: at,
	updatedAt: at,
};
const held: Bead = { ...bead, status: "in_progress", assignee: "acc/r1" };
const detail: BeadDetail = {
	bead,
	timeline: [{ seq: 1, at, beadId: "mm-1", kind: "created", actor: "duke" }],
	seq: 3,
	fold: { bead },
};
const ev = (seq: number, b: Bead, extra = {}): BeadEvent => ({
	seq,
	at,
	op: "update",
	beadId: b.id,
	actor: "acc/r1",
	bead: b,
	...extra,
});

test("folds only this bead's events after the detail's seq, in seq order", () => {
	const { state, seq } = foldAfter(detail, [
		ev(5, held, {
			op: "comment",
			comment: {
				id: "c",
				beadId: "mm-1",
				author: "acc/r1",
				text: "50%",
				createdAt: at,
			},
		}),
		ev(2, held),
		ev(4, held),
		ev(6, { ...held, id: "mm-2" }),
	]);
	expect(seq).toBe(5);
	expect(state.entries.map((e) => e.kind)).toEqual([
		"created",
		"claimed",
		"report",
	]);
});
