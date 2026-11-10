import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckDeps,
	checkDispatch,
	checkRequirement,
	compareVersions,
	FileSetupMemory,
	MemorySetupMemory,
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

/** checkDispatch for a dispatch without a bound environment. */
const checkLegacy = (
	d: Parameters<typeof checkDispatch>[0],
	s: RunnerSettings,
	deps: CheckDeps,
) => checkDispatch(d, s, {}, deps);

describe("checkDispatch", () => {
	const env = (over: object) => ({
		repo: "",
		ref: "main",
		requires: [],
		...over,
	});
	test("ok: no repo runs in the workdir", async () => {
		const r = await checkLegacy(dispatch("a"), settings(), deps);
		expect(r).toEqual({ ok: true, cwd: dir, env: {} });
	});
	test("unmet requirements are all listed", async () => {
		const r = await checkLegacy(
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
		expect(await checkLegacy(d, settings(), deps)).toEqual({
			ok: false,
			reason: "no local checkout for https://g/o/r",
		});
		const r = await checkLegacy(
			d,
			settings({ repos: { "https://g/o/r.git": dir } }),
			deps,
		);
		expect(r.ok && r.cwd).toBe(dir);
	});
	test("a missing workdir or no workdir refuses", async () => {
		const none = settings();
		delete none.workdir;
		expect((await checkLegacy(dispatch("a"), none, deps)).ok).toBe(false);
		const gone = settings({ workdir: "/nonexistent/mm-runner" });
		expect(await checkLegacy(dispatch("a"), gone, deps)).toEqual({
			ok: false,
			reason: "the runner's working directory is missing",
		});
	});
	test("secrets must be set (names only)", async () => {
		const r = await checkLegacy(
			dispatch("a", { env: env({ secrets: ["GH_TOKEN", "NPM_TOKEN"] }) }),
			settings(),
			deps,
		);
		expect(r).toEqual({ ok: false, reason: "secrets not set: NPM_TOKEN" });
	});
	test("setup is off unless allowed; a failing setup refuses", async () => {
		const d = dispatch("a", { env: env({ setup: ["bun install"] }) });
		expect(await checkLegacy(d, settings(), deps)).toEqual({
			ok: false,
			reason: "setup commands are off on this runner",
		});
		const ran: string[] = [];
		const ok = await checkLegacy(d, settings({ allowSetup: true }), {
			...deps,
			setupMemory: new MemorySetupMemory(),
			sh: async (cmd) => {
				ran.push(cmd);
				return { code: 0, tail: "" };
			},
		});
		expect(ok.ok).toBe(true);
		expect(ran).toEqual(["bun install"]);
		const bad = await checkLegacy(d, settings({ allowSetup: true }), {
			...deps,
			setupMemory: new MemorySetupMemory(),
			sh: async () => ({ code: 1, tail: "lockfile" }),
		});
		expect(bad.ok === false && bad.reason).toContain("setup failed (exit 1)");
	});
	test("setup really runs in the checkout", async () => {
		const d = dispatch("a", { env: env({ setup: ["test -d ."] }) });
		const r = await checkLegacy(d, settings({ allowSetup: true }), {
			...deps,
			setupMemory: new MemorySetupMemory(),
			sh: undefined,
		});
		expect(r.ok).toBe(true);
	});
});

describe("checkDispatch with a bound environment", () => {
	const named = (over: object = {}) =>
		dispatch("a", {
			env: { name: "web", repo: "", ref: "main", requires: [], ...over },
		});
	const bound = (over: object = {}) => ({
		binding: { name: "web", dir, ...over },
	});
	const shell = () => {
		const ran: string[] = [];
		return {
			ran,
			sh: async (cmd: string) => {
				ran.push(cmd);
				return cmd.startsWith("false")
					? { code: 1, tail: "not ready: db down" }
					: { code: 0, tail: "" };
			},
		};
	};

	test("works in the binding's checkout, not the workdir", async () => {
		const r = await checkDispatch(
			named(),
			settings({ workdir: "/nonexistent" }),
			bound(),
			deps,
		);
		expect(r).toEqual({ ok: true, cwd: dir, env: {} });
		const gone = await checkDispatch(
			named(),
			settings(),
			bound({ dir: "/nonexistent/web" }),
			deps,
		);
		expect(gone).toEqual({
			ok: false,
			reason: "the checkout of environment web (/nonexistent/web) is missing",
		});
	});

	test("setup needs the binding's allowSetup, not the runner flag", async () => {
		const r = await checkDispatch(
			named({ setup: ["bun install"] }),
			settings({ allowSetup: true }),
			bound(),
			deps,
		);
		expect(r).toEqual({
			ok: false,
			reason: "setup commands are off for environment web (allowSetup)",
		});
	});

	test("setup runs once per checkout and setup hash; check runs every time", async () => {
		const { ran, sh } = shell();
		const d = { ...deps, sh, setupMemory: new MemorySetupMemory() };
		const env = { setup: ["bun install"], check: ["bun --version"] };
		for (let i = 0; i < 3; i++) {
			const r = await checkDispatch(
				named(env),
				settings(),
				bound({ allowSetup: true }),
				d,
			);
			expect(r.ok).toBe(true);
		}
		expect(ran).toEqual([
			"bun install",
			"bun --version",
			"bun --version",
			"bun --version",
		]);
		await checkDispatch(
			named({ ...env, setup: ["bun install", "bun run build"] }),
			settings(),
			bound({ allowSetup: true }),
			d,
		);
		expect(ran.slice(4)).toEqual([
			"bun install",
			"bun run build",
			"bun --version",
		]);
	});

	test("two dispatches at once run one setup", async () => {
		let runs = 0;
		const d = {
			...deps,
			setupMemory: new MemorySetupMemory(),
			sh: async () => {
				runs++;
				await Bun.sleep(20);
				return { code: 0, tail: "" };
			},
		};
		const both = await Promise.all(
			[1, 2].map(() =>
				checkDispatch(
					named({ setup: ["make"] }),
					settings(),
					bound({ allowSetup: true }),
					d,
				),
			),
		);
		expect(both.every((r) => r.ok)).toBe(true);
		expect(runs).toBe(1);
	});

	test("a failed check refuses with the output tail", async () => {
		const { sh } = shell();
		const r = await checkDispatch(
			named({ check: ["false db"] }),
			settings(),
			bound(),
			{ ...deps, sh },
		);
		expect(r).toEqual({
			ok: false,
			reason: "check failed (exit 1): false db\nnot ready: db down",
		});
	});

	test("secrets come from the binding's sources and go to the agent", async () => {
		const f = join(mkdtempSync(join(tmpdir(), "mm-secret-")), "npm");
		writeFileSync(f, "npm-value\n");
		const r = await checkDispatch(
			named({ secrets: ["GH_TOKEN", "NPM_TOKEN", "API_KEY"] }),
			settings(),
			bound({ env: { NPM_TOKEN: `file:${f}`, API_KEY: "env:MY_KEY" } }),
			{ ...deps, env: { GH_TOKEN: "gh", MY_KEY: "k" } },
		);
		expect(r).toEqual({
			ok: true,
			cwd: dir,
			env: { GH_TOKEN: "gh", NPM_TOKEN: "npm-value", API_KEY: "k" },
		});
	});
});

test("FileSetupMemory keeps setup runs across restarts", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "mm-setup-")), "s.json");
	const a = new FileSetupMemory(path);
	expect(await a.has("/w", "h1")).toBe(false);
	await a.mark("/w", "h1");
	const b = new FileSetupMemory(path);
	expect(await b.has("/w", "h1")).toBe(true);
	expect(await b.has("/w", "h2")).toBe(false);
});
