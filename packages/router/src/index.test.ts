import { describe, expect, test } from "bun:test";
import type { Bead } from "@mastermind/core";
import {
	fallbackOf,
	offerOrder,
	type RoutingRule,
	type RunnerState,
	requirementsOf,
	route,
	selectBead,
	selectWaiter,
	target,
} from "./index.ts";

function bead(over: Partial<Bead> = {}): Bead {
	return {
		id: "mm-1",
		title: "t",
		status: "open",
		priority: 2,
		type: "task",
		labels: [],
		blocked: false,
		createdAt: "2026-11-10T00:00:00Z",
		updatedAt: "2026-11-10T00:00:00Z",
		...over,
	};
}

function runner(over: Partial<RunnerState> = {}): RunnerState {
	return {
		user: "duke",
		runner: "r1",
		queues: ["dev"],
		capabilities: [],
		capacity: 1,
		running: 0,
		...over,
	};
}

describe("route", () => {
	const rules: RoutingRule[] = [
		{ match: { labels: ["ui", "web"] }, queue: "design" },
		{ match: { type: "bug", maxPriority: 1 }, queue: "hotfix" },
		{ match: { idPrefix: "ops-" }, queue: "ops" },
		{ match: { type: "bug" }, queue: "bugs" },
	];

	const cases: [string, Partial<Bead>, RoutingRule[], string | null][] = [
		[
			"keeps an existing queue label",
			{ labels: ["queue:x", "ui", "web"] },
			rules,
			"x",
		],
		[
			"ignores an empty queue label",
			{ labels: ["queue:", "ui", "web"] },
			rules,
			"design",
		],
		[
			"labels: all present matches",
			{ labels: ["web", "ui", "extra"] },
			rules,
			"design",
		],
		["labels: one missing does not match", { labels: ["ui"] }, rules, null],
		[
			"type + maxPriority: more urgent matches",
			{ type: "bug", priority: 0 },
			rules,
			"hotfix",
		],
		[
			"type + maxPriority: equal matches",
			{ type: "bug", priority: 1 },
			rules,
			"hotfix",
		],
		[
			"maxPriority: less urgent falls through",
			{ type: "bug", priority: 2 },
			rules,
			"bugs",
		],
		["idPrefix matches", { id: "ops-7" }, rules, "ops"],
		[
			"first matching rule wins",
			{ id: "ops-7", type: "bug", priority: 3 },
			rules,
			"ops",
		],
		["no rule matches: triage", { type: "feature" }, rules, null],
		["no rules: triage", {}, [], null],
		[
			"empty match is a catch-all",
			{},
			[{ match: {}, queue: "default" }],
			"default",
		],
	];
	test.each(cases)("%s", (_name, over, rs, want) => {
		expect(route(bead(over), rs)).toBe(want);
	});
});

describe("target: queue or direct address", () => {
	const rules: RoutingRule[] = [
		{ match: { labels: ["laptop"] }, to: "bob/laptop" },
		{ match: { labels: ["bob"] }, to: "bob", fallback: "dev" },
		{ match: {}, queue: "dev" },
	];
	test("a direct rule gives an address, and route() no queue", () => {
		expect(target(bead({ labels: ["laptop"] }), rules)).toEqual({
			to: "bob/laptop",
		});
		expect(route(bead({ labels: ["laptop"] }), rules)).toBeNull();
		expect(target(bead({ labels: ["bob"] }), rules)).toEqual({ to: "bob" });
		expect(target(bead(), rules)).toEqual({ queue: "dev" });
	});
	test("labels win over rules: queue label first, then to: label", () => {
		expect(target(bead({ labels: ["laptop", "to:carol"] }), rules)).toEqual({
			to: "carol",
		});
		expect(target(bead({ labels: ["to:carol", "queue:ops"] }), rules)).toEqual({
			queue: "ops",
		});
	});
	test("fallbackOf: only a matching rule to the same address", () => {
		expect(fallbackOf(bead({ labels: ["bob"] }), "bob", rules)).toBe("dev");
		expect(fallbackOf(bead({ labels: ["bob"] }), "bob/laptop", rules)).toBe(
			null,
		);
		expect(fallbackOf(bead(), "bob", rules)).toBeNull();
	});
	test("offerOrder: never served first, then least recently, then id", () => {
		const order = offerOrder([
			{ runner: "c", lastServedAt: "2026-11-10T02:00:00Z" },
			{ runner: "b" },
			{ runner: "a", lastServedAt: "2026-11-10T01:00:00Z" },
			{ runner: "a0" },
		]).map((r) => r.runner);
		expect(order).toEqual(["a0", "b", "a", "c"]);
	});
});

describe("requirementsOf", () => {
	const cases: [string, string[], string[]][] = [
		["no labels", [], []],
		[
			"req labels only",
			["req:docker", "ui", "queue:dev", "req:gpu"],
			["docker", "gpu"],
		],
		["empty req label is ignored", ["req:"], []],
		["duplicates collapse", ["req:docker", "req:docker"], ["docker"]],
	];
	test.each(cases)("%s", (_name, labels, want) => {
		expect(requirementsOf({ labels })).toEqual(want);
	});
});

describe("selectBead", () => {
	const ready = [
		bead({
			id: "a",
			priority: 2,
			createdAt: "2026-11-01T00:00:00Z",
			labels: ["queue:dev"],
		}),
		bead({
			id: "b",
			priority: 1,
			createdAt: "2026-11-05T00:00:00Z",
			labels: ["queue:dev"],
		}),
		bead({
			id: "c",
			priority: 1,
			createdAt: "2026-11-03T00:00:00Z",
			labels: ["queue:dev", "req:docker"],
		}),
		bead({
			id: "d",
			priority: 0,
			createdAt: "2026-11-01T00:00:00Z",
			labels: ["queue:other"],
		}),
		bead({
			id: "e",
			priority: 2,
			createdAt: "2026-11-01T00:00:00Z",
			labels: ["queue:dev"],
		}),
	];

	const cases: [string, Partial<RunnerState>, string, Bead[], string | null][] =
		[
			["refuses: not on the queue", { queues: ["other"] }, "dev", ready, null],
			["refuses: at capacity", { capacity: 2, running: 2 }, "dev", ready, null],
			[
				"refuses: over capacity",
				{ capacity: 1, running: 3 },
				"dev",
				ready,
				null,
			],
			["priority, then age; skips unmet requirement", {}, "dev", ready, "b"],
			[
				"capability unlocks older bead at same priority",
				{ capabilities: ["docker"] },
				"dev",
				ready,
				"c",
			],
			[
				"only beads on the asked queue",
				{ queues: ["dev", "other"] },
				"dev",
				ready,
				"b",
			],
			[
				"same priority and age: id breaks the tie",
				{},
				"dev",
				[ready[4], ready[0]] as Bead[],
				"a",
			],
			["nothing ready", {}, "dev", [], null],
			["nothing the runner can do", {}, "dev", [ready[2]] as Bead[], null],
		];
	test.each(cases)("%s", (_name, over, queue, rs, want) => {
		expect(selectBead(runner(over), queue, rs)?.id ?? null).toBe(want);
	});

	test("does not reorder the input", () => {
		const input = [...ready];
		selectBead(runner(), "dev", input);
		expect(input.map((b) => b.id)).toEqual(ready.map((b) => b.id));
	});
});

describe("selectWaiter", () => {
	const dev = { labels: ["queue:dev"] };
	const docker = { labels: ["queue:dev", "req:docker"] };
	const t = (h: number) => `2026-11-10T0${h}:00:00Z`;

	const cases: [
		string,
		Pick<Bead, "labels">,
		Partial<RunnerState>[],
		string | null,
	][] = [
		["no waiters", dev, [], null],
		["bead has no queue", { labels: [] }, [{ runner: "r1" }], null],
		[
			"skips runner not on the queue",
			dev,
			[{ runner: "r1", queues: ["x"] }, { runner: "r2" }],
			"r2",
		],
		[
			"skips runner at capacity",
			dev,
			[{ runner: "r1", running: 1 }, { runner: "r2" }],
			"r2",
		],
		[
			"skips runner without capability",
			docker,
			[{ runner: "r1" }, { runner: "r2", capabilities: ["docker"] }],
			"r2",
		],
		["nobody eligible", docker, [{ runner: "r1" }], null],
		[
			"user served least recently wins",
			dev,
			[
				{ user: "a", runner: "a1", lastServedAt: t(5) },
				{ user: "b", runner: "b1", lastServedAt: t(3) },
			],
			"b1",
		],
		[
			"never-served user wins",
			dev,
			[
				{ user: "a", runner: "a1", lastServedAt: t(1) },
				{ user: "b", runner: "b1" },
			],
			"b1",
		],
		[
			"fairness is per user, not per runner",
			dev,
			[
				// user a has a stale runner, but a was served at 5 through a2.
				{ user: "a", runner: "a1", lastServedAt: t(1) },
				{ user: "a", runner: "a2", lastServedAt: t(5), running: 1 },
				{ user: "b", runner: "b1", lastServedAt: t(3) },
			],
			"b1",
		],
		[
			"same user: least recently served runner",
			dev,
			[
				{ user: "a", runner: "a1", lastServedAt: t(4) },
				{ user: "a", runner: "a2", lastServedAt: t(2) },
			],
			"a2",
		],
		[
			"full tie: first waiter",
			dev,
			[
				{ user: "a", runner: "a1" },
				{ user: "b", runner: "b1" },
			],
			"a1",
		],
	];
	test.each(cases)("%s", (_name, b, ws, want) => {
		expect(selectWaiter(b, ws.map(runner))?.runner ?? null).toBe(want);
	});
});

describe("selectWaiter: two accounts share one queue (mm-210.65)", () => {
	const shared = { labels: ["queue:shared"] };
	const t = (h: number) => `2026-11-10T0${h}:00:00Z`;
	const a = (runner: string, extra: Partial<RunnerState> = {}) => ({
		user: "a",
		runner,
		queues: ["shared", "a-only"],
		...extra,
	});
	const b = (runner: string, extra: Partial<RunnerState> = {}) => ({
		user: "b",
		runner,
		queues: ["shared"],
		...extra,
	});

	const cases: [string, Partial<RunnerState>[], string][] = [
		[
			"more runners of A do not win over B",
			[
				a("a1", { lastServedAt: t(4) }),
				a("a2"),
				a("a3"),
				b("b1", { lastServedAt: t(3) }),
			],
			"b1",
		],
		[
			"A's never-served runner does not count: A was served through a1",
			[
				a("a1", { lastServedAt: t(5), running: 1 }),
				a("a2"),
				b("b1", { lastServedAt: t(2) }),
			],
			"b1",
		],
		[
			"B waits first, A served less recently: A wins",
			[b("b1", { lastServedAt: t(4) }), a("a1", { lastServedAt: t(2) })],
			"a1",
		],
		[
			"B's only runner is full: A gets it",
			[b("b1", { running: 1 }), a("a1", { lastServedAt: t(5) })],
			"a1",
		],
		[
			"a runner of B not on the shared queue is skipped",
			[b("b1", { queues: ["other"] }), a("a1", { lastServedAt: t(5) })],
			"a1",
		],
	];
	test.each(cases)("%s", (_name, ws, want) => {
		expect(selectWaiter(shared, ws.map(runner))?.runner).toBe(want);
	});

	test("a stream of beads alternates between the accounts", () => {
		const ws = [a("a1"), a("a2"), a("a3"), b("b1")].map(runner);
		const got: string[] = [];
		for (let h = 1; h <= 6; h++) {
			const w = selectWaiter(shared, ws);
			if (!w) throw new Error("no waiter");
			w.lastServedAt = t(h);
			got.push(w.user);
		}
		expect(got).toEqual(["a", "b", "a", "b", "a", "b"]);
	});
});
