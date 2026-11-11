import { describe, expect, test } from "bun:test";
import type { Bead } from "@mastermind/core";
import { LogRing, redact } from "./log-ring.ts";
import { debugRoutes } from "./routes.ts";
import { type DebugSources, debugState, type summarizeItems } from "./state.ts";

const now = new Date("2026-11-11T10:00:00Z");

function bead(id: string, over: Partial<Bead> = {}): Bead {
	return {
		id,
		title: `t ${id}`,
		status: "open",
		priority: 2,
		type: "task",
		labels: [],
		blocked: false,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		...over,
	};
}

const sources: DebugSources = {
	version: "abc123",
	startedAt: new Date("2026-11-11T09:00:00Z"),
	now: () => now,
	auth: () => ({
		accounts: async () => [
			{ id: "duke", createdAt: "2026-11-10T00:00:00Z", invitedBy: null },
		],
		serviceAccounts: async () =>
			[
				{
					id: "s1",
					account: "duke",
					name: "laptop",
					createdAt: "2026-11-10T00:00:00Z",
					// a hash must never leave, even when a source returns one
					secretHash: "deadbeef",
				},
			] as never,
	}),
	runners: () =>
		[
			{
				account: "duke",
				runner: "laptop",
				serviceAccount: "s1",
				queues: ["main"],
				capabilities: [],
				providers: ["claude"],
				capacity: 1,
				version: "v1",
				running: [],
				lastSeenAt: now.toISOString(),
				online: true,
			},
		] as never,
	routing: () => ({ read: async () => ({ doc: { queues: [] }, revision: 3 }) }),
	environments: () => null,
	items: async () => [
		bead("a", { labels: ["queue:main"] }),
		bead("b"),
		bead("c", {
			status: "in_progress",
			assignee: "duke/laptop",
			labels: ["queue:main"],
			lease: {
				expiresAt: "2026-11-11T10:05:00Z",
				heartbeatAt: "2026-11-11T09:59:00Z",
			},
		}),
		bead("d", { status: "closed", closedAt: now.toISOString() }),
	],
};

describe("debug state", () => {
	test("snapshot: accounts, service accounts without secrets, runners, routing, items", async () => {
		const s = await debugState(sources);
		expect(s.version).toBe("abc123");
		expect(s.uptimeSeconds).toBe(3600);
		expect(s.accounts).toEqual([
			{ id: "duke", createdAt: "2026-11-10T00:00:00Z", invitedBy: null },
		]);
		expect(JSON.stringify(s)).not.toContain("deadbeef");
		expect(s.runners[0]?.online).toBe(true);
		expect(s.routing).toEqual({ doc: { queues: [] }, revision: 3 });
		expect(s.environments).toEqual({
			error: "environments is off or starting",
		});
		const items = s.items as ReturnType<typeof summarizeItems>;
		expect(items.columns).toEqual({ ready: 2, in_progress: 1, done: 1 });
		expect(items.unrouted).toEqual(["b"]);
		expect(items.readyPerQueue).toEqual({ main: 1, "(none)": 1 });
		expect(items.claimed).toEqual([
			{
				id: "c",
				title: "t c",
				status: "in_progress",
				queue: "main",
				holder: "duke/laptop",
				leaseExpiresAt: "2026-11-11T10:05:00Z",
				heartbeatAt: "2026-11-11T09:59:00Z",
				lease: "live",
			},
		]);
	});

	test("a slow section times out alone", async () => {
		const s = await debugState({
			...sources,
			timeoutMs: 20,
			auth: () => ({
				accounts: () => new Promise(() => {}),
				serviceAccounts: async () => [],
			}),
		});
		expect(s.accounts).toEqual({ error: "timed out after 20ms" });
		expect(s.serviceAccounts).toEqual([]);
	});
});

describe("log ring", () => {
	test("keeps the last n lines, redacted", () => {
		const ring = new LogRing(2, () => now);
		ring.push("one");
		ring.push("cred mms_duke_s1_SECRETxyz failed");
		ring.push("code ABCD-EFGH, token mme_abc, Bearer k3y");
		expect(ring.lines().map((l) => l.line)).toEqual([
			"cred mms_[redacted] failed",
			"code [code], token mme_[redacted], Bearer [redacted]",
		]);
	});

	test("redact leaves plain text alone", () => {
		expect(redact("work: start failed (timeout)")).toBe(
			"work: start failed (timeout)",
		);
	});
});

describe("debug routes", () => {
	const get = (
		routes: ReturnType<typeof debugRoutes>,
		auth?: string,
	): Promise<Response> =>
		routes["/api/debug/state"].GET(
			new Request("http://x/api/debug/state", {
				headers: auth ? { authorization: auth } : {},
			}),
		);

	test("off without an operator key", async () => {
		const res = await get(
			debugRoutes({ sources, audit: () => {} }),
			"Bearer x",
		);
		expect(res.status).toBe(404);
	});

	test("401 without the key or with a wrong one; 200 with it; audit has no secret", async () => {
		const lines: string[] = [];
		const routes = debugRoutes({
			operatorKey: "opkey",
			sources,
			audit: (l) => lines.push(l),
		});
		expect((await get(routes)).status).toBe(401);
		expect((await get(routes, "Bearer nope")).status).toBe(401);
		const ok = await get(routes, "Bearer opkey");
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { version: string }).version).toBe("abc123");
		expect(lines).toHaveLength(3);
		expect(lines.join("\n")).not.toContain("opkey");
	});

	test("rate limited per address", async () => {
		const routes = debugRoutes({
			operatorKey: "k",
			sources,
			audit: () => {},
			perMinute: 1,
		});
		expect((await get(routes, "Bearer k")).status).toBe(200);
		expect((await get(routes, "Bearer k")).status).toBe(429);
	});
});
