import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	type AgentSpec,
	LaunchError,
	PaseoLauncher,
	parseResult,
	RESULT_SCHEMA,
} from "../src/launcher.ts";
import { FAKE_PASEO, fakePaseoDir } from "./fakes.ts";

const fake = fakePaseoDir();
afterAll(() => rmSync(fake.dir, { recursive: true, force: true }));

const launcher = new PaseoLauncher({
	command: FAKE_PASEO,
	env: { FAKE_PASEO_DIR: fake.dir, PASEO_AGENT_ID: "" },
});
let n = 0;
const spec = (prompt: string, over: Partial<AgentSpec> = {}): AgentSpec => ({
	executionId: `mm-1-${++n}`,
	beadId: "mm-1",
	title: "mm-1: fix it",
	cwd: "/repo",
	prompt,
	agent: { provider: "claude/claude-haiku-5-5", mode: "bypassPermissions" },
	...over,
});
const never = new AbortController().signal;

describe("PaseoLauncher (fake paseo CLI)", () => {
	test("runs paseo with cwd, provider, mode, labels and the result schema", async () => {
		const s = spec("fix the bug");
		const res = await launcher.run(s, never);
		expect(res).toEqual({ status: "done", summary: "did: fix the bug" });
		const run = fake.calls().find((c) => c.args[0] === "run");
		const args = run?.args ?? [];
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		expect(after("--cwd")).toBe("/repo");
		expect(after("--provider")).toBe("claude/claude-haiku-5-5");
		expect(after("--mode")).toBe("bypassPermissions");
		expect(JSON.parse(after("--output-schema") as string)).toEqual(
			RESULT_SCHEMA,
		);
		expect(args).toContain(`mastermind.execution=${s.executionId}`);
		expect(args).toContain("mastermind.bead=mm-1");
		expect(args.at(-1)).toBe("fix the bug");
	});

	test("a routed target's host, labels and the agent env go to ls and run", async () => {
		const before = fake.calls().length;
		const s = spec("routed", {
			host: "gpu-box:6767",
			labels: { pool: "gpu" },
			env: { HF_TOKEN: "t" },
		});
		await launcher.run(s, never);
		const calls = fake.calls().slice(before);
		for (const c of calls)
			expect(c.args[c.args.indexOf("--host") + 1]).toBe("gpu-box:6767");
		const args = calls.find((c) => c.args[0] === "run")?.args ?? [];
		expect(args[args.indexOf("--env") + 1]).toBe("HF_TOKEN=t");
		expect(args).toContain("pool=gpu");
	});

	test("does not pass the caller's Paseo agent scope to the CLI", async () => {
		const scoped = new PaseoLauncher({
			command: FAKE_PASEO,
			env: { FAKE_PASEO_DIR: fake.dir },
		});
		const before = process.env.PASEO_AGENT_ID;
		process.env.PASEO_AGENT_ID = "caller";
		try {
			await scoped.run(spec("scoped"), never);
		} finally {
			if (before === undefined) delete process.env.PASEO_AGENT_ID;
			else process.env.PASEO_AGENT_ID = before;
		}
		expect(fake.calls().at(-1)?.agentEnv).toBeNull();
	});

	test("the agent's failed answer comes back as failed", async () => {
		expect(await launcher.run(spec("FAKE:fail"), never)).toEqual({
			status: "failed",
			summary: "could not do it",
		});
	});

	test("a CLI error or an answer that is not the schema throws", async () => {
		await expect(launcher.run(spec("FAKE:crash"), never)).rejects.toThrow(
			/exited 2:[\s\S]*daemon is not running/,
		);
		await expect(launcher.run(spec("FAKE:garbage"), never)).rejects.toThrow(
			LaunchError,
		);
	});

	test("never starts a second agent for one execution id", async () => {
		const s = spec("once");
		await launcher.run(s, never);
		await expect(launcher.run(s, never)).rejects.toThrow(/already exists/);
	});

	test("abort kills the run and stops the agent", async () => {
		const ctl = new AbortController();
		const s = spec("FAKE:slow");
		const running = launcher.run(s, ctl.signal);
		for (let i = 0; i < 200; i++) {
			if ((await launcher.find(s.executionId)).length) break;
			await Bun.sleep(20);
		}
		ctl.abort();
		await expect(running).rejects.toThrow(/stopped/);
		const stop = fake.calls().find((c) => c.args[0] === "stop");
		expect(stop?.args[1]).toStartWith("agent-");
	});
});

test("parseResult", () => {
	expect(parseResult(' {"status":"done","summary":"x"}\n')).toEqual({
		status: "done",
		summary: "x",
	});
	expect(() => parseResult('{"status":"ok"}')).toThrow(LaunchError);
});
