import { expect, test } from "bun:test";
import type { Bead, BeadEvent } from "@mastermind/core";
import { choices, emptyFeed, filterRows, foldFeed } from "./feed.ts";

const at = "2026-11-10T08:00:00.000Z";
const open: Bead = {
	id: "mm-1",
	title: "Fix login",
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: at,
	updatedAt: at,
};
const queued = { ...open, labels: ["queue:build"] };
const held = { ...queued, status: "in_progress" as const, assignee: "acc/r1" };
const ev = (seq: number, op: string, actor: string, bead: Bead): BeadEvent => ({
	seq,
	at,
	op,
	beadId: bead.id,
	actor,
	bead,
});

test("folds per bead, newest first, and filters by queue and account", () => {
	let feed = foldFeed(emptyFeed(), [
		ev(1, "create", "duke", open),
		ev(2, "update", "mastermind", queued),
		ev(3, "create", "ann", { ...open, id: "mm-2", title: "Other" }),
	]);
	feed = foldFeed(feed, [
		ev(4, "update", "acc/r1", held),
		ev(2, "update", "x", open),
	]);
	expect(feed.seq).toBe(4);
	expect(feed.rows.map((r) => [r.seq, r.kind, r.beadId])).toEqual([
		[4, "claimed", "mm-1"],
		[3, "created", "mm-2"],
		[2, "routed", "mm-1"],
		[1, "created", "mm-1"],
	]);
	expect(feed.rows[0]?.title).toBe("Fix login");
	expect(
		filterRows(feed.rows, { queue: "build", account: "" }).map((r) => r.seq),
	).toEqual([4, 2]);
	expect(
		filterRows(feed.rows, { queue: "", account: "acc" }).map((r) => r.seq),
	).toEqual([4]);
	expect(choices(feed.rows)).toEqual({
		queues: ["build"],
		accounts: ["acc", "ann", "duke", "mastermind"],
	});
});
