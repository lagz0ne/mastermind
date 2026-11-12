import { describe, expect, test } from "bun:test";
import type { AccountView, RunnerView } from "@mastermind/core";
import {
	ago,
	groupByAccount,
	outdated,
	runnerCommand,
	statsOf,
} from "./people.ts";

const account = (id: string, invitedBy: string | null = null): AccountView => ({
	id,
	invitedBy,
	createdAt: "2026-11-10T07:00:00.000Z",
});

const runner = (
	acc: string,
	id: string | null,
	extra: Partial<RunnerView> = {},
): RunnerView => ({
	account: acc,
	serviceAccount: { id: `sa-${id}`, name: `${id}`, createdAt: "" },
	runner: id,
	online: id !== null,
	lastSeenAt: id ? "2026-11-10T08:00:00.000Z" : null,
	queues: [],
	capabilities: [],
	providers: [],
	capacity: null,
	running: [],
	version: null,
	...extra,
});

describe("groupByAccount", () => {
	test("the name is the display name, else the id", () => {
		const g = groupByAccount(
			[{ ...account("lagz0ne"), displayName: "Lagz0ne" }, account("bob")],
			[runner("zed", "z1")],
		);
		expect(g.map((x) => [x.account, x.name])).toEqual([
			["lagz0ne", "Lagz0ne"],
			["bob", "bob"],
			["zed", "zed"],
		]);
	});

	test("accounts in order with their runners; unknown accounts last", () => {
		const g = groupByAccount(
			[account("admin"), account("bob", "admin")],
			[runner("bob", "b1"), runner("zed", "z1"), runner("admin", "a1")],
		);
		expect(
			g.map((x) => [x.account, x.invitedBy, x.runners.map((r) => r.runner)]),
		).toEqual([
			["admin", null, ["a1"]],
			["bob", "admin", ["b1"]],
			["zed", null, ["z1"]],
		]);
	});
});

describe("statsOf", () => {
	test("counts connected runners only; busy and slots from running and capacity", () => {
		const g = groupByAccount(
			[account("admin")],
			[
				runner("admin", "a1", { capacity: 3, running: ["mm-1", "mm-2"] }),
				runner("admin", "a2", { online: false, capacity: 1 }),
				runner("admin", null),
			],
		);
		expect(statsOf(g)).toEqual({
			accounts: 1,
			runners: 2,
			online: 1,
			busy: 2,
			slots: 4,
		});
	});

	test("slots are unlimited when one runner is", () => {
		const g = groupByAccount(
			[account("admin")],
			[
				runner("admin", "a1", { capacity: 3 }),
				runner("admin", "a2", { capacity: "unlimited", running: ["mm-1"] }),
			],
		);
		expect(statsOf(g)).toMatchObject({ busy: 1, slots: null });
	});
});

describe("ago", () => {
	test("seconds, minutes, hours, never", () => {
		const t = Date.parse("2026-11-10T08:00:00.000Z");
		const iso = new Date(t).toISOString();
		expect(ago(iso, t + 3_000)).toBe("3 s ago");
		expect(ago(iso, t + 14 * 60_000)).toBe("14 min ago");
		expect(ago(iso, t + 3 * 3_600_000)).toBe("3 h ago");
		expect(ago(null, t)).toBe("never");
	});
});

describe("runnerCommand", () => {
	test("install from this site, enrol with the token, start", () => {
		expect(runnerCommand("https://mm.example", "mme_abc-_1", "build")).toBe(
			"curl -fsSL https://mm.example/install.sh | sh && ~/.local/bin/mastermind-runner enroll mme_abc-_1 --url https://mm.example --queue build --workdir . && ~/.local/bin/mastermind-runner start",
		);
	});

	test("quotes words a shell would split", () => {
		expect(runnerCommand("http://x", "t", "a b'c")).toContain(
			"--queue 'a b'\\''c'",
		);
	});
});

test("outdated: a connected runner on another commit than the server", () => {
	expect(outdated(runner("a", "r", { version: "abc" }), "abc")).toBe(false);
	expect(outdated(runner("a", "r", { version: "old" }), "abc")).toBe(true);
	expect(outdated(runner("a", "r"), "abc")).toBe(true);
	expect(outdated(runner("a", null), "abc")).toBe(false);
	expect(outdated(runner("a", "r", { version: "old" }), undefined)).toBe(false);
});
