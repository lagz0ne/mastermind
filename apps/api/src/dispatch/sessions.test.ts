import { describe, expect, test } from "bun:test";
import { RunnerSessions } from "./sessions.ts";

function setup(liveMs = 120_000) {
	let t = Date.parse("2026-11-12T09:00:00Z");
	const s = new RunnerSessions({ liveMs, now: () => t });
	return { s, advance: (ms: number) => (t += ms) };
}

const A = "lagz0ne/yo-buid";
const old = { session: "aaaa-old", startedAt: "2026-11-12T08:00:00Z" };
const neu = { session: "bbbb-new", startedAt: "2026-11-12T08:50:00Z" };

describe("one live session per runner (mm-210.79)", () => {
	test("the same session goes on; one session alone is no duplicate", () => {
		const { s } = setup();
		expect(s.check(A, old)).toEqual({ ok: true, tookOver: false });
		expect(s.check(A, old)).toEqual({ ok: true, tookOver: false });
		expect(s.duplicates()).toEqual([]);
	});

	test("a newer session wins; the older is refused for good and flagged", () => {
		const { s } = setup();
		s.check(A, old);
		expect(s.check(A, neu)).toEqual({ ok: true, tookOver: true });
		const v = s.check(A, old);
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.reason).toStartWith("superseded: a newer process of runner");
			expect(v.reason).toContain("session bbbb-new");
		}
		expect(s.check(A, neu).ok).toBe(true);
		const [d] = s.duplicates();
		expect(d?.actor).toBe(A);
		expect(d?.session).toBe("bbbb-new");
		expect(d?.refused).toEqual([
			{
				session: "aaaa-old",
				startedAt: "2026-11-12T08:00:00.000Z",
				lastSeenAt: "2026-11-12T09:00:00.000Z",
				count: 1,
			},
		]);
		expect(d?.line).toStartWith("duplicate session:");
	});

	test("an older session that comes second is refused (order does not matter)", () => {
		const { s } = setup();
		s.check(A, neu);
		expect(s.check(A, old).ok).toBe(false);
		expect(s.check(A, neu).ok).toBe(true);
	});

	test("a runner without session id: allowed alone, refused while a session is live", () => {
		const { s, advance } = setup();
		expect(s.check(A, {}).ok).toBe(true);
		s.check(A, neu);
		const v = s.check(A, {});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("sends no session id");
		expect(s.duplicate(A)?.refused[0]?.session).toBeNull();
		// The live one stops: the old runner may work again.
		advance(121_000);
		expect(s.check(A, {}).ok).toBe(true);
	});

	test("a normal restart is no duplicate: the old process is gone, never refused", () => {
		const { s, advance } = setup();
		s.check(A, old);
		advance(5_000);
		expect(s.check(A, neu)).toEqual({ ok: true, tookOver: true });
		expect(s.duplicates()).toEqual([]);
		// Its waiting request would be refused, without counting.
		expect(s.refusal(A, old)).toStartWith("superseded:");
		expect(s.refusal(A, neu)).toBeNull();
		expect(s.duplicates()).toEqual([]);
	});

	test("a live session that went quiet can be replaced, even by an older start time (clock)", () => {
		const { s, advance } = setup();
		s.check(A, neu);
		advance(121_000);
		expect(s.check(A, old)).toEqual({ ok: true, tookOver: true });
		expect(s.check(A, neu).ok).toBe(false);
	});

	test("the flag ends when the refused process is quiet for liveMs", () => {
		const { s, advance } = setup();
		s.check(A, neu);
		s.check(A, old);
		expect(s.duplicates()).toHaveLength(1);
		advance(60_000);
		s.check(A, neu);
		advance(61_000);
		expect(s.duplicates()).toEqual([]);
	});

	test("runners are separate", () => {
		const { s } = setup();
		s.check(A, neu);
		expect(s.check("lagz0ne/other", old).ok).toBe(true);
	});
});
