import { expect, test } from "bun:test";
import { ago, clock, leaseView } from "./lease.ts";

const t0 = Date.parse("2026-11-10T08:00:00Z");
const lease = {
	heartbeatAt: "2026-11-10T07:59:12Z",
	expiresAt: "2026-11-10T08:04:12Z",
};

test("live, expiring under a minute, expired at the instant", () => {
	expect(leaseView(lease, t0)).toEqual({
		look: "live",
		left: "4:12",
		beatAgoS: 48,
	});
	expect(leaseView(lease, t0 + 212_000).look).toBe("expiring");
	expect(leaseView(lease, t0 + 252_000)).toMatchObject({
		look: "expired",
		left: "0:00",
	});
	expect(leaseView(undefined, t0).look).toBe("none");
});

test("clock rounds up to whole seconds", () => {
	expect(clock(61_001)).toBe("1:02");
	expect(clock(-5)).toBe("0:00");
});

test("ago picks the unit", () => {
	const at = "2026-11-10T08:00:00Z";
	expect(ago(at, t0 + 12_000)).toBe("12 s");
	expect(ago(at, t0 + 240_000)).toBe("4 min");
	expect(ago(at, t0 + 3 * 3_600_000)).toBe("3 h");
	expect(ago(at, t0 + 2 * 86_400_000)).toBe("2 d");
});
