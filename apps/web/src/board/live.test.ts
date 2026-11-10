import { describe, expect, test } from "bun:test";
import type { Bead, BeadEvent } from "@mastermind/core";
import { applyEvent } from "./live.ts";

const bead = (id: string, title: string): Bead => ({
	id,
	title,
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: "2026-11-10T00:00:00.000Z",
	updatedAt: "2026-11-10T00:00:00.000Z",
});

const event = (seq: number, op: string, b: Bead | null): BeadEvent => ({
	seq,
	at: "2026-11-10T00:00:00.000Z",
	op,
	beadId: b?.id ?? "mm-1",
	actor: "test",
	...(b ? { bead: b } : {}),
});

describe("applyEvent", () => {
	test("adds a new bead and replaces an updated one", () => {
		let beads = new Map<string, Bead>();
		beads = applyEvent(beads, event(1, "create", bead("mm-1", "first")));
		beads = applyEvent(beads, event(2, "update", bead("mm-1", "renamed")));
		expect([...beads.values()].map((b) => b.title)).toEqual(["renamed"]);
	});

	test("is idempotent: a replayed event changes nothing", () => {
		const e = event(1, "create", bead("mm-1", "first"));
		const once = applyEvent(new Map(), e);
		expect(applyEvent(once, e)).toEqual(once);
	});

	test("a delete removes the bead and leaves the input untouched", () => {
		const before = applyEvent(new Map(), event(1, "create", bead("mm-1", "x")));
		const after = applyEvent(before, event(2, "delete", null));
		expect(after.size).toBe(0);
		expect(before.size).toBe(1);
	});
});
