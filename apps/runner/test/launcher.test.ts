import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSpec,
	isLocalHost,
	LaunchError,
	PaseoLauncher,
	PROVIDER_LOGIN_FIX,
	parseResult,
	providerLoginMessage,
	RESULT_SCHEMA,
	runFailure,
} from "../src/launcher.ts";
import { FakePaseo } from "./paseo/fake.ts";

const fake = new FakePaseo();
const launcher = new PaseoLauncher({ connect: fake.connect });
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
const created = (from: number) =>
	fake.agents.slice(from).at(-1) as (typeof fake.agents)[number];

describe("PaseoLauncher (fake Paseo SDK)", () => {
	test("creates the agent with cwd, provider, model, mode, labels and the result schema", async () => {
		const before = fake.agents.length;
		const s = spec("fix the bug");
		const res = await launcher.run(s, never);
		expect(res).toEqual({ status: "done", summary: "did: fix the bug" });
		const a = created(before);
		expect(a.cwd).toBe("/repo");
		expect(a.provider).toBe("claude");
		expect(a.model).toBe("claude-haiku-5-5");
		expect(a.modeId).toBe("bypassPermissions");
		expect(a.labels).toMatchObject({
			"mastermind.execution": s.executionId,
			"mastermind.bead": "mm-1",
		});
		expect(a.prompt).toStartWith("fix the bug");
		expect(a.prompt).toContain(JSON.stringify(RESULT_SCHEMA, null, 2));
		const opts = fake.ops("createAgent").at(-1)?.arg as {
			outputSchema: unknown;
		};
		expect(opts.outputSchema).toEqual(RESULT_SCHEMA);
		expect(fake.open).toBe(0);
	});

	test("a routed target's host and labels go to the lookup and the agent", async () => {
		const from = fake.calls.length;
		const s = spec("routed", {
			host: "gpu-box:6767",
			labels: { pool: "gpu" },
		});
		await launcher.run(s, never);
		const calls = fake.calls.slice(from);
		expect(calls.length).toBeGreaterThan(2);
		for (const c of calls) expect(c.host).toBe("gpu-box:6767");
		expect(fake.agents.at(-1)?.labels.pool).toBe("gpu");
	});

	test("secret values never go to Paseo: the agent gets a private env file, deleted after", async () => {
		const before = fake.agents.length;
		const env = { HF_TOKEN: "hf-s3cret", GH_TOKEN: "it's\nmulti" };
		await launcher.run(spec("with secrets", { env }), never);
		const a = created(before);
		const sent = JSON.stringify(fake.ops("createAgent").at(-1)?.arg);
		for (const v of Object.values(env)) expect(sent).not.toContain(v);
		const f = a.envFile;
		if (!f) throw new Error("no env file during the run");
		expect(f.mode).toBe(0o600);
		expect(f.dirMode).toBe(0o700);
		expect(a.env?.MASTERMIND_SECRETS_DIR).toBe(f.path.slice(0, -4));
		// The env file (copied: the original is gone) gives back the exact values.
		const copy = join(tmpdir(), `mm-env-copy-${process.pid}`);
		await Bun.write(copy, f.text);
		const out = Bun.spawnSync([
			"sh",
			"-c",
			`. '${copy}' && printf '%s|%s' "$HF_TOKEN" "$GH_TOKEN"`,
		]);
		expect(out.stdout.toString()).toBe(`${env.HF_TOKEN}|${env.GH_TOKEN}`);
		// The prompt names the secrets (not the values) and how to load them.
		expect(a.prompt).toContain("HF_TOKEN, GH_TOKEN");
		expect(existsSync(f.path)).toBe(false);
	});

	test("the secrets file is deleted when the agent fails", async () => {
		const before = fake.agents.length;
		await launcher
			.run(spec("FAKE:crash", { env: { A: "x" } }), never)
			.catch(() => {});
		const f = created(before)?.envFile;
		expect(f).toBeTruthy();
		expect(existsSync(f?.path ?? "/")).toBe(false);
	});

	test("secrets are not sent to a Paseo host on another machine", async () => {
		const before = fake.agents.length;
		const err = await launcher
			.run(spec("x", { host: "gpu-box:6767", env: { A: "x" } }), never)
			.catch((e: Error) => e.message);
		expect(err).toContain("the Paseo host gpu-box:6767 cannot read them");
		expect(fake.agents.length).toBe(before);
		expect(isLocalHost("localhost:6767")).toBe(true);
		expect(isLocalHost("tcp://127.0.0.1:6767")).toBe(true);
		expect(isLocalHost("/home/me/.paseo/paseo.sock")).toBe(true);
		expect(isLocalHost("[::1]:6767")).toBe(true);
		expect(isLocalHost("ssh://gpu-box")).toBe(false);
	});

	test("no provider, or a mode that asks: the reason and the fix", async () => {
		const run = (agent: AgentSpec["agent"]) =>
			launcher.run(spec("x", { agent }), never).then(
				() => "ok",
				(e: Error) => e.message,
			);
		expect(await run({})).toStartWith("no provider for the agent; fix: ");
		expect(await run({ provider: "claude", mode: "plan" })).toBe(
			"the Paseo agent failed: paseo: the agent is waiting for permission before producing structured output (the agent mode asks for permission; fix: mastermind-runner start --mode auto --save)",
		);
	});

	test("an agent that cannot log in to its provider fails with the reason and the fix, at once (mm-210.72)", async () => {
		const sends = fake.ops("sendMessage").length;
		const err = await launcher.run(spec("FAKE:nologin"), never).then(
			() => null,
			(e: Error) => e,
		);
		expect(err).toBeInstanceOf(LaunchError);
		expect(err?.message).toStartWith(
			'provider login failed: the agent\'s provider answered "Not logged"',
		);
		expect(err?.message).toContain("Not logged in · Please run /login");
		expect(err?.message).toEndWith(`; fix: ${PROVIDER_LOGIN_FIX}`);
		expect(fake.ops("sendMessage").length).toBe(sends);
	});

	test("a daemon that does not answer: Paseo's reason", async () => {
		fake.down.add("down:6767");
		await expect(
			launcher.run(spec("x", { host: "down:6767" }), never),
		).rejects.toThrow(/paseo: the Paseo daemon at down:6767 does not answer/);
	});

	test("the agent's failed answer comes back as failed", async () => {
		expect(await launcher.run(spec("FAKE:fail"), never)).toEqual({
			status: "failed",
			summary: "could not do it",
		});
	});

	test("a dropped connection or an answer that is not the schema throws (2 retries)", async () => {
		await expect(launcher.run(spec("FAKE:crash"), never)).rejects.toThrow(
			/daemon connection closed/,
		);
		const sends = fake.ops("sendMessage").length;
		await expect(launcher.run(spec("FAKE:garbage"), never)).rejects.toThrow(
			/does not match the result schema/,
		);
		expect(fake.ops("sendMessage").length).toBe(sends + 2);
	}, 30_000);

	test("never starts a second agent for one execution id", async () => {
		const s = spec("once");
		await launcher.run(s, never);
		await expect(launcher.run(s, never)).rejects.toThrow(/already exists/);
	});

	test("abort cancels the agent", async () => {
		const ctl = new AbortController();
		const s = spec("FAKE:slow");
		const running = launcher.run(s, ctl.signal);
		for (let i = 0; i < 200; i++) {
			if ((await launcher.find(s.executionId)).length) break;
			await Bun.sleep(20);
		}
		ctl.abort();
		await expect(running).rejects.toThrow(/stopped/);
		const id = (await launcher.find(s.executionId))[0];
		expect(fake.ops("cancelAgent").map((c) => c.arg)).toContain(id);
	});
});

test("parseResult", () => {
	expect(parseResult(' {"status":"done","summary":"x"}\n')).toEqual({
		status: "done",
		summary: "x",
	});
	expect(() => parseResult('{"status":"ok"}')).toThrow(LaunchError);
});

describe("provider login failures (mm-210.72)", () => {
	// Real paseo 0.15.4 output: claude with no credential in its config.
	const evidence = {
		code: 1,
		stdout: JSON.stringify({
			error: {
				code: "OUTPUT_SCHEMA_FAILED",
				message: "Agent response did not match the required output schema",
				details:
					"Invalid JSON: Unexpected token 'N', \"Not logged\"... is not valid JSON",
			},
		}),
		stderr: "",
	};

	test("runFailure names the login failure and the fix", () => {
		const why = runFailure(evidence);
		expect(why).toStartWith("provider login failed: ");
		expect(why).toContain("mastermind-runner secrets set ANTHROPIC_API_KEY");
	});

	test("known provider auth messages match; other failures do not", () => {
		for (const t of [
			"Not logged in · Please run /login",
			"Invalid API key · Please run /login",
			'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
			"OAuth token has expired",
			"unexpected status 401 Unauthorized",
			// production, mm-awdc (Claude Code 2.1.322 with a refused setup-token):
			"Failed to authenticate. API Error: 401 OAuth access token is invalid.",
		])
			expect(providerLoginMessage(t)).not.toBeNull();
		for (const t of [
			"Agent is waiting for permission before producing structured output",
			"MISSING_PROVIDER: Provider is required",
			"daemon is not running",
			"logged in as acme",
		])
			expect(providerLoginMessage(t)).toBeNull();
	});

	test("a permission wait still gets its own fix", () => {
		const why = runFailure({
			code: 1,
			stdout: JSON.stringify({
				error: {
					code: "OUTPUT_SCHEMA_FAILED",
					message:
						"Agent is waiting for permission before producing structured output",
				},
			}),
			stderr: "",
		});
		expect(why).toContain("--mode auto");
		expect(why).not.toContain("provider login failed");
	});
});
