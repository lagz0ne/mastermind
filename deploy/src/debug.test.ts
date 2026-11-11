import { describe, expect, test } from "bun:test";
import {
	debugError,
	debugPath,
	fetchDebug,
	followDebug,
	formatDoctor,
	formatEvent,
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
					capacity: "unlimited",
					running: [],
					serviceAccount: "s1",
					diagnostics: {
						secrets: {
							needed: ["GITHUB_TOKEN", "X"],
							missing: ["GITHUB_TOKEN"],
						},
					},
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
		expect(text).toContain("unlimited");
		expect(text).toContain("missing secrets");
		expect(text).toContain("GITHUB_TOKEN");
		expect(text).toContain("ERROR: timed out after 5000ms");
		expect(text).toContain("unrouted (open, no queue): mm-1");
		expect(text).toContain("main   duke");
		expect(text).toContain("default queue -");
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

describe("debug events cli", () => {
	test("parses events and errors", () => {
		expect(parseDebugArgs(["events", "--follow", "--since", "7"])).toEqual({
			what: "events",
			follow: true,
			since: 7,
			json: false,
		});
		expect(parseDebugArgs(["errors"])).toEqual({ what: "errors", json: false });
		expect(parseDebugArgs(["events", "--since", "x"])).toBeNull();
		expect(
			debugPath({ what: "events", follow: true, since: 3, json: false }),
		).toBe("events?since=3&follow=1");
		expect(debugPath({ what: "errors", json: false })).toBe("state");
	});

	test("follows an SSE answer split across chunks", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				const e = new TextEncoder();
				c.enqueue(e.encode(': keep-alive\n\nevent: work\ndata: {"seq":1,'));
				c.enqueue(
					e.encode(
						'"op":"create","item":"mm-1"}\n\nevent: error\ndata: {"line":"x"}\n\n',
					),
				);
				c.close();
			},
		});
		const fake = (async () =>
			new Response(body, {
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof fetch;
		const got: [string, unknown][] = [];
		await followDebug(
			"https://m",
			"k",
			"events?follow=1",
			(ev, d) => got.push([ev, d]),
			fake,
		);
		expect(got).toEqual([
			["work", { seq: 1, op: "create", item: "mm-1" }],
			["error", { line: "x" }],
		]);
		expect(
			formatEvent("runner", {
				runner: "a/b",
				online: false,
				queues: ["build"],
				running: [],
				lastSeenAt: "t",
			}),
		).toContain("OFFLINE");
	});
});

describe("debug doctor cli", () => {
	test("parses <account>/<runner> and --deep; POSTs to the runner's doctor route", async () => {
		const a = parseDebugArgs(["doctor", "lagz0ne/yo-buid", "--deep"]);
		expect(a).toEqual({
			what: "doctor",
			account: "lagz0ne",
			runner: "yo-buid",
			deep: true,
			json: false,
		});
		expect(debugPath(a as never)).toBe("runners/lagz0ne/yo-buid/doctor?deep=1");
		expect(parseDebugArgs(["doctor", "lagz0ne"])).toBeNull();
		expect(parseDebugArgs(["doctor"])).toBeNull();
		let method = "";
		const fake = (async (_url: string, init: RequestInit) => {
			method = init.method ?? "";
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;
		await fetchDebug("https://m", "k", "runners/a/b/doctor", fake, {
			method: "POST",
		});
		expect(method).toBe("POST");
		expect(debugError(404, "runner a/b does not answer")).toBe(
			"HTTP 404: runner a/b does not answer",
		);
	});

	test("formats a report and shows lastDoctor in debug state", () => {
		const report = {
			runner: "yo-buid",
			at: "2026-11-11T09:59:00Z",
			deep: true,
			ok: false,
			steps: [
				{ id: "a", name: "config", status: "pass", ms: 80, detail: ["ok"] },
				{
					id: "e",
					name: "agent",
					status: "fail",
					ms: 4000,
					detail: ["paseo run exited 1: OUTPUT_SCHEMA_FAILED"],
					fix: "mastermind-runner start --mode auto --save",
				},
			],
		};
		const text = formatDoctor(report);
		expect(text).toContain("FAIL e. agent (4000 ms)");
		expect(text).toContain("fix: mastermind-runner start --mode auto --save");
		const state = formatState({
			version: "abc",
			now: "2026-11-11T10:00:00Z",
			startedAt: "2026-11-11T09:00:00Z",
			uptimeSeconds: 3600,
			nats: [],
			accounts: [],
			serviceAccounts: [],
			runners: [
				{
					account: "lagz0ne",
					runner: "yo-buid",
					online: true,
					queues: [],
					running: [],
					diagnostics: { lastDoctor: report },
				},
			],
			routing: { error: "x" },
			environments: { error: "x" },
			items: { error: "x" },
			errors: [],
		});
		expect(state).toContain("doctor lagz0ne/yo-buid");
		expect(state).toContain("a PASS, e FAIL");
		expect(state).toContain("OUTPUT_SCHEMA_FAILED  fix: mastermind-runner");
	});
});
