import { expect, test } from "bun:test";
import { columnOf, queueOf } from "@mastermind/core";
import depAdd from "./fixtures/wire/events-dep-add.json";
import {
	toBead,
	toBeadEvent,
	toPriority,
	toStatus,
	type WireEvent,
} from "./wire.ts";

test("is_blocked from a journal snapshot sets blocked", () => {
	const [record] = depAdd.records as WireEvent[];
	if (!record) throw new Error("fixture is empty");
	const event = toBeadEvent(record);
	expect(event).toMatchObject({
		seq: 12,
		op: "dep_add",
		beadId: "pr-a4o",
		actor: "probe",
		at: "2026-11-10T05:45:43.000Z",
	});
	expect(event.bead?.blocked).toBe(true);
	expect(event.bead?.labels).toEqual([]);
	if (!event.bead) throw new Error("no bead");
	expect(columnOf(event.bead)).toBe("blocked");
});

test("a delete record has no bead", () => {
	const event = toBeadEvent({
		seq: 1,
		ts: "2026-11-10T05:33:50Z",
		op: "delete",
		issue_id: "pr-a4o",
		actor: "probe",
	});
	expect(event.bead).toBeUndefined();
});

test("empty strings are left out and the queue label survives", () => {
	const bead = toBead({
		id: "pr-1",
		title: "t",
		description: "",
		assignee: "",
		status: "open",
		priority: 2,
		issue_type: "task",
		labels: ["env:bun", "queue:bob"],
		created_at: "2026-11-10T05:33:51Z",
		updated_at: "2026-11-10T05:33:51Z",
	});
	expect("description" in bead).toBe(false);
	expect("assignee" in bead).toBe(false);
	expect(queueOf(bead)).toBe("bob");
});

test("custom statuses park and priorities clamp", () => {
	expect(toStatus("review")).toBe("deferred");
	expect(toStatus("hooked")).toBe("hooked");
	expect(toPriority(-1)).toBe(0);
	expect(toPriority(9)).toBe(4);
	expect(toPriority(Number.NaN)).toBe(2);
});
