import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {
	type AgentSpec,
	isLocalHost,
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

	test("a routed target's host and labels go to ls and run", async () => {
		const before = fake.calls().length;
		const s = spec("routed", {
			host: "gpu-box:6767",
			labels: { pool: "gpu" },
		});
		await launcher.run(s, never);
		const calls = fake.calls().slice(before);
		for (const c of calls)
			expect(c.args[c.args.indexOf("--host") + 1]).toBe("gpu-box:6767");
		const args = calls.find((c) => c.args[0] === "run")?.args ?? [];
		expect(args).toContain("pool=gpu");
	});

	type EnvFile = { path: string; text: string; mode: number; dirMode: number };
	const runCall = (from: number) =>
		fake
			.calls()
			.slice(from)
			.find((c) => c.args[0] === "run") as
			| { args: string[]; envFile: EnvFile | null }
			| undefined;

	test("secret values never go on argv: the agent gets a private env file, deleted after", async () => {
		const before = fake.calls().length;
		const env = { HF_TOKEN: "hf-s3cret", GH_TOKEN: "it's\nmulti" };
		await launcher.run(spec("with secrets", { env }), never);
		const run = runCall(before);
		const argv = run?.args.join("\n") ?? "";
		for (const v of Object.values(env)) expect(argv).not.toContain(v);
		for (const k of Object.keys(env)) expect(argv).not.toContain(`${k}=`);
		const f = run?.envFile;
		if (!f) throw new Error("no env file during the run");
		expect(f.mode).toBe(0o600);
		expect(f.dirMode).toBe(0o700);
		expect(argv).toContain(`MASTERMIND_SECRETS_DIR=${f.path.slice(0, -4)}`);
		// The env file (copied: the original is gone) gives back the exact values.
		const copy = `${fake.dir}/env.copy`;
		await Bun.write(copy, f.text);
		const out = Bun.spawnSync([
			"sh",
			"-c",
			`. '${copy}' && printf '%s|%s' "$HF_TOKEN" "$GH_TOKEN"`,
		]);
		expect(out.stdout.toString()).toBe(`${env.HF_TOKEN}|${env.GH_TOKEN}`);
		// The prompt names the secrets (not the values) and how to load them.
		expect(run?.args.at(-1)).toContain("HF_TOKEN, GH_TOKEN");
		expect(existsSync(f.path)).toBe(false);
	});

	test("the secrets file is deleted when the agent fails", async () => {
		const before = fake.calls().length;
		await launcher
			.run(spec("FAKE:crash", { env: { A: "x" } }), never)
			.catch(() => {});
		const f = runCall(before)?.envFile;
		expect(f).toBeTruthy();
		expect(existsSync(f?.path ?? "/")).toBe(false);
	});

	test("secrets are not sent to a Paseo host on another machine", async () => {
		const before = fake.calls().length;
		const err = await launcher
			.run(spec("x", { host: "gpu-box:6767", env: { A: "x" } }), never)
			.catch((e: Error) => e.message);
		expect(err).toContain("secrets cannot go to the Paseo host gpu-box:6767");
		expect(runCall(before)).toBeUndefined();
		expect(isLocalHost("localhost:6767")).toBe(true);
		expect(isLocalHost("tcp://127.0.0.1:6767")).toBe(true);
		expect(isLocalHost("/home/me/.paseo/paseo.sock")).toBe(true);
		expect(isLocalHost("[::1]:6767")).toBe(true);
		expect(isLocalHost("ssh://gpu-box")).toBe(false);
	});

	test("paseo's JSON error is the reason; a permission wait names the fix", async () => {
		const run = (agent: AgentSpec["agent"]) =>
			launcher.run(spec("x", { agent }), never).then(
				() => "ok",
				(e: Error) => e.message,
			);
		expect(await run({})).toBe(
			"paseo run exited 1: MISSING_PROVIDER: Provider is required: Pass --provider <provider> or --provider <provider>/<model>",
		);
		expect(await run({ provider: "claude", mode: "plan" })).toBe(
			"paseo run exited 1: OUTPUT_SCHEMA_FAILED: Agent is waiting for permission before producing structured output (the agent mode asks for permission; fix: mastermind-runner start --mode auto --save)",
		);
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
