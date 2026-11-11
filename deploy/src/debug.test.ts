import { describe, expect, test } from "bun:test";
import {
	debugPath,
	fetchDebug,
	formatItem,
	formatState,
	parseDebugArgs,
} from "./debug.ts";

describe("debug cli", () => {
	test("parses state and --json", () => {
		expect(parseDebugArgs(["state"])).toEqual({ what: "state", json: false });
		expect(parseDebugArgs(["state", "--json"])).toEqual({
			what: "state",
			json: true,
		});
		expect(parseDebugArgs([])).toBeNull();
		expect(parseDebugArgs(["nope"])).toBeNull();
	});

	test("sends the key as Bearer and maps 401", async () => {
		let auth = "";
		const fake = (async (_url: string, init: RequestInit) => {
			auth = new Headers(init.headers).get("authorization") ?? "";
			return Response.json({ error: "operator key required" }, { status: 401 });
		}) as unknown as typeof fetch;
		await expect(fetchDebug("https://m/", "k", "state", fake)).rejects.toThrow(
			"refused the operator key",
		);
		expect(auth).toBe("Bearer k");
	});

	test("formats a snapshot, with a failed section shown as an error", () => {
		const text = formatState({
			version: "abc",
			now: "2026-11-11T10:00:00Z",
			startedAt: "2026-11-11T09:00:00Z",
			uptimeSeconds: 3600,
			nats: [
				{
					name: "mastermind-app",
					state: "connected",
					server: "nats:4222",
					reconnects: 2,
					lastError: null,
				},
			],
			accounts: [{ id: "duke", createdAt: "x", invitedBy: null }],
			serviceAccounts: { error: "timed out after 5000ms" },
			runners: [
				{
					account: "duke",
					runner: "laptop",
					online: false,
					lastSeenAt: "2026-11-11T09:58:00Z",
					version: "v1",
					queues: ["main"],
					capacity: 1,
					running: [],
					serviceAccount: "s1",
				},
			],
			routing: {
				revision: 2,
				doc: {
					queues: [{ name: "main", members: ["duke"] }],
					rules: [{ queue: "main" }],
				},
			},
			environments: { error: "environments is off or starting" },
			items: {
				total: 1,
				columns: { ready: 1 },
				readyPerQueue: { "(none)": 1 },
				unrouted: ["mm-1"],
				claimed: [],
			},
			errors: [{ at: "2026-11-11T09:59:00Z", line: "work: boom" }],
		});
		expect(text).toContain("duke/laptop");
		expect(text).toContain("NO");
		expect(text).toContain("2m ago");
		expect(text).toContain("ERROR: timed out after 5000ms");
		expect(text).toContain("unrouted (open, no queue): mm-1");
		expect(text).toContain("main   duke");
		expect(text).toContain("work: boom");
	});
});

describe("debug item cli", () => {
	test("parses item <id> and builds the path", () => {
		const a = parseDebugArgs(["item", "mm-1", "--json"]);
		expect(a).toEqual({ what: "item", id: "mm-1", json: true });
		expect(debugPath(a as never)).toBe("items/mm-1");
		expect(parseDebugArgs(["item"])).toBeNull();
	});

	test("formats the reasons an item is not offered", () => {
		const text = formatItem({
			item: { id: "mm-1", title: "fix it", status: "open", labels: [] },
			routing: {
				queue: null,
				by: "none",
				ruleIndex: null,
				members: null,
				requires: [],
				runners: [],
				blockers: ["no queue: label and no rule matches (it stays unrouted)"],
			},
			timeline: [
				{
					seq: 4,
					at: "t",
					op: "create",
					actor: "duke",
					bead: { status: "open" },
				},
			],
			comments: [],
		});
		expect(text).toContain("NOT OFFERED because:");
		expect(text).toContain("stays unrouted");
		expect(text).toContain("#4  t  create  duke  -> open");
	});
});
