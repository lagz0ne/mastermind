import { expect, test } from "bun:test";
import {
	type BeadStatus,
	BOARD_COLUMNS,
	columnOf,
	leaseState,
	queueLabel,
	queueOf,
} from "./work.ts";

test("columnOf maps every bd status to a column or parks it", () => {
	const cases: [BeadStatus, boolean, ReturnType<typeof columnOf>][] = [
		["open", false, "ready"],
		["open", true, "blocked"],
		["in_progress", false, "in_progress"],
		["hooked", false, "in_progress"],
		["blocked", false, "blocked"],
		["closed", false, "done"],
		["closed", true, "done"],
		["deferred", false, null],
		["pinned", false, null],
	];
	for (const [status, blocked, column] of cases) {
		expect(columnOf({ status, blocked })).toBe(column);
	}
});

test("every column that columnOf returns is a board column", () => {
	for (const status of ["open", "in_progress", "blocked", "closed"] as const) {
		const column = columnOf({ status, blocked: false });
		expect(column).not.toBeNull();
		expect(BOARD_COLUMNS).toContain(column as NonNullable<typeof column>);
	}
});

test("queueOf reads the queue label and ignores other labels", () => {
	expect(queueOf({ labels: ["env:bun", queueLabel("alice")] })).toBe("alice");
	expect(queueOf({ labels: ["env:bun"] })).toBeNull();
	expect(queueOf({ labels: ["queue:"] })).toBeNull();
	expect(queueOf({ labels: [] })).toBeNull();
});

test("leaseState compares the expiry with now", () => {
	const now = new Date("2026-11-10T06:00:00Z");
	const lease = (expiresAt: string) => ({ expiresAt, heartbeatAt: expiresAt });
	expect(leaseState(undefined, now)).toBe("none");
	expect(leaseState(lease("2026-11-10T06:05:00Z"), now)).toBe("live");
	expect(leaseState(lease("2026-11-10T06:00:00Z"), now)).toBe("expired");
	expect(leaseState(lease("2026-11-10T05:55:00Z"), now)).toBe("expired");
});
