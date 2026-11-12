/**
 * mm-210.82: doctor --deep step e in box mode sends the probe the way a task
 * goes: the box launcher, a probe environment, the model secret (its value
 * only for the proxy), never the local Claude login.
 */
import { describe, expect, test } from "bun:test";
import {
	BOX_LOGIN_FIX,
	boxProbeLauncher,
	probeEnv,
	probeModelSecret,
} from "../src/doctor-probe.ts";
import {
	type AgentLauncher,
	type AgentSpec,
	LaunchError,
	providerLoginMessage,
} from "../src/launcher.ts";

function fakeBox(fail?: string) {
	const specs: AgentSpec[] = [];
	const box: AgentLauncher = {
		async run(spec) {
			specs.push(spec);
			if (fail) throw new LaunchError(fail);
			return { status: "done", summary: "OK" };
		},
	};
	return { box, specs };
}

const spec: AgentSpec = {
	executionId: "doctor-1",
	beadId: "doctor",
	title: "probe: mastermind doctor laptop",
	cwd: "/home/u/src",
	prompt: "Reply with the single word OK.",
	agent: { provider: "claude", mode: "auto" },
	labels: { purpose: "probe" },
	host: "127.0.0.1:6767",
};

describe("doctor probe in a box", () => {
	test("the spec gets the probe environment and the model secret; no local Paseo host", async () => {
		const { box, specs } = fakeBox();
		const l = boxProbeLauncher(box, {
			name: "CLAUDE_CODE_OAUTH_TOKEN",
			value: "sk-ant-oat01-x",
		});
		const r = await l.run(spec, new AbortController().signal);
		expect(r).toEqual({ status: "done", summary: "OK" });
		const s = specs[0] as AgentSpec;
		expect(s.recipe).toEqual(probeEnv("CLAUDE_CODE_OAUTH_TOKEN"));
		expect(s.recipe?.secrets).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
		expect(s.recipe?.repo).toBe("");
		expect(s.recipe?.output).toEqual({ kind: "none" });
		expect(s.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
		expect(s.host).toBeUndefined();
		expect(s.prompt).toBe(spec.prompt);
		expect(s.agent).toEqual(spec.agent);
		expect(await l.find("doctor-1")).toEqual([]);
	});

	test("no model credential: the probe still runs, with no secret", async () => {
		const { box, specs } = fakeBox();
		await boxProbeLauncher(box, null).run(spec, new AbortController().signal);
		expect(specs[0]?.recipe?.secrets).toEqual([]);
		expect(specs[0]?.env).toEqual({});
	});

	test("a refused login in the box reaches step e as the box launcher's error", async () => {
		const text =
			'provider login failed: the agent\'s provider answered "authentication_error" (API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."}})';
		const { box } = fakeBox(text);
		const err = await boxProbeLauncher(box, null)
			.run(spec, new AbortController().signal)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LaunchError);
		expect(providerLoginMessage((err as Error).message)).toBeTruthy();
		expect(BOX_LOGIN_FIX).toContain("claude setup-token");
	});

	test("the model secret: the OAuth token first (the proxy's order), store before env", async () => {
		expect(
			await probeModelSecret({
				store: { ANTHROPIC_API_KEY: "k" },
				env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
			}),
		).toEqual({
			name: "CLAUDE_CODE_OAUTH_TOKEN",
			value: "t",
			from: "env:CLAUDE_CODE_OAUTH_TOKEN",
		});
		expect(
			await probeModelSecret({
				store: { CLAUDE_CODE_OAUTH_TOKEN: "s" },
				env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
			}),
		).toMatchObject({ value: "s", from: "store" });
		expect(await probeModelSecret({ store: {}, env: {} })).toBeNull();
	});
});
