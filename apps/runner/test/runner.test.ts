import { afterEach, describe, expect, test } from "bun:test";
import type { CheckResult } from "../src/check.ts";
import { defaultSettings, type RunnerSettings } from "../src/config.ts";
import { agentPrompt, executionId, Runner } from "../src/runner.ts";
import { dispatch, FakeLauncher, FakeMastermind, until } from "./fakes.ts";

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	...defaultSettings("laptop"),
	queues: ["q"],
	workdir: "/tmp",
	...over,
});
const pass = async (): Promise<CheckResult> => ({
	ok: true,
	cwd: "/work",
	agent: { provider: "claude" },
});

let runner: Runner | undefined;
afterEach(async () => {
	await runner?.stop();
	runner = undefined;
});

function make(
	mm: FakeMastermind,
	launcher: FakeLauncher,
	over: Partial<RunnerSettings> = {},
	check = pass,
) {
	runner = new Runner({
		client: mm,
		launcher,
		settings: settings(over),
		check,
		idleMs: 10,
		heartbeatMs: 20,
		backoff: { minMs: 5, maxMs: 20 },
	});
	runner.start();
	return runner;
}

describe("Runner", () => {
	test("done: completes the bead with the agent's summary", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "fixed it" });
		mm.push(dispatch("mm-1"));
		make(mm, agents);
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.verbs("complete")[0]).toEqual({
			verb: "complete",
			bead: "mm-1",
			actor: "alice/laptop",
			text: "fixed it",
		});
		expect(mm.verbs("report")[0]?.text).toContain("starting a claude agent");
		const spec = agents.specs[0];
		expect(spec?.cwd).toBe("/work");
		expect(spec?.prompt).toContain("do mm-1");
		expect(spec?.prompt).toContain('status "done"');
		expect(spec?.executionId).toStartWith("mm-1-");
	});

	test("failed: releases the bead with the agent's reason", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-2"));
		make(mm, new FakeLauncher({ status: "failed", summary: "tests are red" }));
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toBe("tests are red");
		expect(mm.verbs("complete")).toHaveLength(0);
	});

	test("a failed check releases without starting an agent", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "x" });
		mm.push(dispatch("mm-3"));
		make(mm, agents, {}, async () => ({
			ok: false,
			reason: "git: not on PATH",
		}));
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toBe("git: not on PATH");
		expect(agents.specs).toHaveLength(0);
	});

	test("never runs more agents than capacity", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		for (const id of ["a", "b", "c"]) mm.push(dispatch(id));
		make(mm, agents, { capacity: 2 });
		await until(() => agents.specs.length === 2);
		await Bun.sleep(50);
		expect(agents.specs).toHaveLength(2);
		agents.finish("a", { status: "done", summary: "ok" });
		await until(() => agents.specs.length === 3);
		expect(agents.maxActive).toBe(2);
	});

	test("capacity is shared by all queues", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("a", { queue: "q" }));
		mm.push(dispatch("b", { queue: "r" }));
		make(mm, agents, { queues: ["q", "r"], capacity: 1 });
		await until(() => agents.specs.length === 1);
		await Bun.sleep(50);
		expect(agents.specs).toHaveLength(1);
		agents.finish(agents.specs[0]?.beadId as string, {
			status: "done",
			summary: "ok",
		});
		await until(() => agents.specs.length === 2);
	});

	test("heartbeats while the agent runs; a lost claim stops the agent", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("mm-4"));
		make(mm, agents);
		await until(() => mm.verbs("heartbeat").length >= 2);
		mm.lost.add("mm-4");
		await until(() => agents.aborted.includes("mm-4"));
		await Bun.sleep(30);
		expect(mm.verbs("complete")).toHaveLength(0);
		expect(mm.verbs("release")).toHaveLength(0);
		expect(runner?.running()).toEqual([]);
	});

	test("stop stops running agents and gives their beads back", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("mm-5"));
		const r = make(mm, agents);
		await until(() => agents.specs.length === 1);
		await r.stop();
		expect(agents.aborted).toEqual(["mm-5"]);
		expect(mm.verbs("release")[0]?.text).toBe("runner stopped");
	});

	test("a ready notice wakes an idle poller at once", async () => {
		const mm = new FakeMastermind();
		mm.waitMs = 0;
		const agents = new FakeLauncher({ status: "done", summary: "ok" });
		runner = new Runner({
			client: mm,
			launcher: agents,
			settings: settings(),
			check: pass,
			idleMs: 60_000,
		});
		runner.start();
		await until(() => mm.nextCalls === 1);
		mm.push(dispatch("mm-6"));
		mm.ready("q");
		await until(() => mm.verbs("complete").length === 1, 1000);
	});

	test("next errors back off and recover", async () => {
		const mm = new FakeMastermind();
		mm.failNext = 3;
		mm.push(dispatch("mm-7"));
		make(mm, new FakeLauncher({ status: "done", summary: "ok" }));
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.nextCalls).toBeGreaterThanOrEqual(4);
	});

	test("an agent that throws is reported as failed", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-8"));
		const agents = new FakeLauncher();
		agents.run = async () => {
			throw new Error("paseo run exited 2: daemon is not running");
		};
		make(mm, agents);
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toContain("daemon is not running");
	});
});

test("executionId is stable per claim and differs between claims", () => {
	const a = dispatch("mm-1.2");
	expect(executionId(a)).toBe(executionId({ ...a }));
	const b = { ...a, lease: { ...a.lease, expiresAt: "2030-01-01T00:00:00Z" } };
	expect(executionId(b)).not.toBe(executionId(a));
	expect(agentPrompt(a)).toContain("bead mm-1.2, queue q, stage work");
});
