import { describe, expect, test } from "bun:test";
import type { Bead } from "@mastermind/core";
import { fixtureBeads } from "./fixture.ts";
import { ALL, filterByQueue, groupByColumn, queueCounts } from "./group.ts";

const bead = (over: Partial<Bead> & Pick<Bead, "id">): Bead => ({
	title: over.id,
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: "2026-11-10T00:00:00Z",
	updatedAt: "2026-11-10T00:00:00Z",
	...over,
});

const ids = (beads: Bead[]) => beads.map((b) => b.id);

describe("groupByColumn", () => {
	test("places beads by columnOf and drops parked ones", () => {
		const board = groupByColumn([
			bead({ id: "a" }),
			bead({ id: "b", blocked: true }),
			bead({ id: "c", status: "blocked" }),
			bead({ id: "d", status: "in_progress" }),
			bead({ id: "e", status: "hooked" }),
			bead({ id: "f", status: "closed" }),
			bead({ id: "g", status: "deferred" }),
			bead({ id: "h", status: "pinned" }),
		]);
		expect(ids(board.ready)).toEqual(["a"]);
		expect(ids(board.blocked).sort()).toEqual(["b", "c"]);
		expect(ids(board.in_progress).sort()).toEqual(["d", "e"]);
		expect(ids(board.done)).toEqual(["f"]);
	});

	test("every column exists even when empty", () => {
		expect(groupByColumn([])).toEqual({
			ready: [],
			in_progress: [],
			blocked: [],
			done: [],
		});
	});

	test("sorts by priority, then most recently updated", () => {
		const board = groupByColumn([
			bead({ id: "p2-old", priority: 2, updatedAt: "2026-11-10T01:00:00Z" }),
			bead({ id: "p2-new", priority: 2, updatedAt: "2026-11-10T02:00:00Z" }),
			bead({ id: "p0", priority: 0, updatedAt: "2026-11-09T00:00:00Z" }),
		]);
		expect(ids(board.ready)).toEqual(["p0", "p2-new", "p2-old"]);
	});

	test("the fixture fills every column and leaves out the deferred bead", () => {
		const beads = fixtureBeads(new Date("2026-11-10T12:00:00Z"));
		const board = groupByColumn(beads);
		for (const column of Object.values(board)) {
			expect(column.length).toBeGreaterThan(0);
		}
		const placed = Object.values(board).flat().length;
		expect(placed).toBe(beads.length - 1);
	});
});

describe("queue filter", () => {
	const beads = [
		bead({ id: "a", labels: ["queue:web"] }),
		bead({ id: "b", labels: ["queue:backend"] }),
		bead({ id: "c" }),
		bead({ id: "d", labels: ["queue:web"], status: "deferred" }),
	];
	test("all, unrouted, one queue", () => {
		expect(filterByQueue(beads, ALL)).toBe(beads);
		expect(ids([...filterByQueue(beads, { kind: "unrouted" })])).toEqual(["c"]);
		expect(
			ids([...filterByQueue(beads, { kind: "queue", name: "web" })]),
		).toEqual(["a", "d"]);
	});
	test("counts skip parked beads and sort queues by name", () => {
		expect(queueCounts(beads)).toEqual({
			queues: [
				{ name: "backend", count: 1 },
				{ name: "web", count: 1 },
			],
			unrouted: 1,
		});
	});
});
