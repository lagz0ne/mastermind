import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
	agentFor,
	type CheckDeps,
	checkDispatch,
	checkRequirement,
	compareVersions,
	repoDir,
	versionIn,
} from "../src/check.ts";
import { defaultSettings, type RunnerSettings } from "../src/config.ts";
import { dispatch } from "./fakes.ts";

const tools: Record<string, string> = { git: "2.43.0", bun: "1.4.4" };
const deps: CheckDeps = {
	which: (b) => (b in tools ? `/bin/${b}` : null),
	version: async (b) => `${b} version ${tools[b]} (linux)`,
	isGitDir: async () => true,
	env: { GH_TOKEN: "x" },
	platform: "linux",
	arch: "x64",
};
const dir = tmpdir();
const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	...defaultSettings("laptop"),
	queues: ["q"],
	workdir: dir,
	capabilities: [
		"git",
		"bun>=1.4",
		"bun>=2",
		"os:linux",
		"arch:arm64",
		"gpu:a100",
		"rg",
	],
	...over,
});

test("versions", () => {
	expect(compareVersions("1.10", "1.9")).toBe(1);
	expect(compareVersions("1.4.4", "1.4")).toBe(1);
	expect(compareVersions("1.4", "1.4.0")).toBe(0);
	expect(compareVersions("0.9", "1")).toBe(-1);
	expect(versionIn("git version 2.43.0\n")).toBe("2.43.0");
	expect(versionIn("nothing")).toBeNull();
});

describe("checkRequirement", () => {
	const s = settings();
	const cases: [string, string | null][] = [
		["git", null],
		["bun>=1.4", null],
		["bun>=2", "bun>=2: bun is 1.4.4"],
		["os:linux", null],
		["arch:arm64", "arch:arm64: this runner is arch:x64"],
		["gpu:a100", null],
		["rg", "rg: not on PATH"],
		["docker", "docker: not offered by this runner"],
	];
	for (const [req, want] of cases)
		test(req, async () => {
			expect(await checkRequirement(req, s, deps)).toBe(want);
		});
});

test("repoDir tolerates .git and trailing slashes", () => {
	const repos = { "https://github.com/o/r.git": "/src/r" };
	expect(repoDir(repos, "https://github.com/o/r")).toBe("/src/r");
	expect(repoDir(repos, "https://github.com/o/r/")).toBe("/src/r");
	expect(repoDir(repos, "https://github.com/o/x")).toBeUndefined();
});

test("agentFor: work uses the agent, enrichment needs the assistant", () => {
	const s = settings({ agent: { provider: "claude", mode: "auto" } });
	expect(agentFor(dispatch("a"), s)).toEqual({
		provider: "claude",
		mode: "auto",
	});
	expect(agentFor(dispatch("a", { stage: "enrich_input" }), s)).toBe(
		"no assistant agent configured for stage enrich_input",
	);
	const d = dispatch("a", {
		env: { repo: "", ref: "main", requires: [], provider: "codex" },
	});
	expect(agentFor(d, s)).toBe("provider codex is not offered by this runner");
	expect(agentFor(d, { ...s, providers: ["claude", "codex"] })).toEqual({
		provider: "codex",
		mode: "auto",
	});
});

describe("checkDispatch", () => {
	const env = (over: object) => ({
		repo: "",
		ref: "main",
		requires: [],
		...over,
	});
	test("ok: no repo runs in the workdir", async () => {
		const r = await checkDispatch(dispatch("a"), settings(), deps);
		expect(r).toEqual({ ok: true, cwd: dir, agent: {} });
	});
	test("unmet requirements are all listed", async () => {
		const r = await checkDispatch(
			dispatch("a", { env: env({ requires: ["rg", "docker"] }) }),
			settings(),
			deps,
		);
		expect(r).toEqual({
			ok: false,
			reason: "rg: not on PATH; docker: not offered by this runner",
		});
	});
	test("a repo needs a local checkout", async () => {
		const d = dispatch("a", { env: env({ repo: "https://g/o/r" }) });
		expect(await checkDispatch(d, settings(), deps)).toEqual({
			ok: false,
			reason: "no local checkout for https://g/o/r",
		});
		const r = await checkDispatch(
			d,
			settings({ repos: { "https://g/o/r.git": dir } }),
			deps,
		);
		expect(r.ok && r.cwd).toBe(dir);
	});
	test("a missing workdir or no workdir refuses", async () => {
		const none = settings();
		delete none.workdir;
		expect((await checkDispatch(dispatch("a"), none, deps)).ok).toBe(false);
		const gone = settings({ workdir: "/nonexistent/mm-runner" });
		expect(await checkDispatch(dispatch("a"), gone, deps)).toEqual({
			ok: false,
			reason: "the runner's working directory is missing",
		});
	});
	test("secrets must be set (names only)", async () => {
		const r = await checkDispatch(
			dispatch("a", { env: env({ secrets: ["GH_TOKEN", "NPM_TOKEN"] }) }),
			settings(),
			deps,
		);
		expect(r).toEqual({ ok: false, reason: "secrets not set: NPM_TOKEN" });
	});
	test("setup is off unless allowed; a failing setup refuses", async () => {
		const d = dispatch("a", { env: env({ setup: ["bun install"] }) });
		expect(await checkDispatch(d, settings(), deps)).toEqual({
			ok: false,
			reason: "setup commands are off on this runner",
		});
		const ran: string[] = [];
		const ok = await checkDispatch(d, settings({ allowSetup: true }), {
			...deps,
			sh: async (cmd) => {
				ran.push(cmd);
				return { code: 0, tail: "" };
			},
		});
		expect(ok.ok).toBe(true);
		expect(ran).toEqual(["bun install"]);
		const bad = await checkDispatch(d, settings({ allowSetup: true }), {
			...deps,
			sh: async () => ({ code: 1, tail: "lockfile" }),
		});
		expect(bad.ok === false && bad.reason).toContain("setup failed (exit 1)");
	});
	test("setup really runs in the checkout", async () => {
		const d = dispatch("a", { env: env({ setup: ["test -d ."] }) });
		const r = await checkDispatch(d, settings({ allowSetup: true }), {
			...deps,
			sh: undefined,
		});
		expect(r.ok).toBe(true);
	});
});
