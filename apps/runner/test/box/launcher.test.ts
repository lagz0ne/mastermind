import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_LABEL } from "../../src/box/driver.ts";
import {
	BoxLauncher,
	boxCheck,
	DEFAULT_BOX_IMAGE,
	startBoxMode,
} from "../../src/box/launcher.ts";
import { defaultSettings } from "../../src/config.ts";
import { type AgentSpec, LaunchError } from "../../src/launcher.ts";
import { FakeDriver } from "./fake-driver.ts";

const out = mkdtempSync(join(tmpdir(), "mm-boxl-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const never = new AbortController().signal;
const settings = defaultSettings("laptop");
const env = (secrets: string[]) => ({
	env: { repo: "", ref: "main", requires: ["bun>=9"], secrets },
});

describe("boxCheck", () => {
	test("secrets from the store, the env, or a routing binding; no host checks", async () => {
		const check = boxCheck({
			loadSecrets: async () => ({ A: "from-store" }),
			env: { B: "from-env", OTHER: "x" },
		});
		const r = await check(env(["A", "B", "C"]), settings, {
			binding: {
				name: "web",
				dir: "/nowhere",
				env: { C: "env:OTHER" },
			} as never,
		});
		// requires bun>=9 and a missing checkout dir do not matter in a box
		expect(r).toEqual({
			ok: true,
			cwd: "/workspace",
			env: { A: "from-store", B: "from-env", C: "x" },
		});
	});
	test("an environment with a repo also gets the runner's own git credential, never missing (mm-210.87)", async () => {
		const store = {
			CLAUDE_CODE_OAUTH_TOKEN: "oauth",
			GITHUB_APP_ID: "123",
			GITHUB_APP_PRIVATE_KEY: "pem",
			GITHUB_APP_SLUG: "mm-runner",
			OTHER: "not for this task",
		};
		const check = boxCheck({ loadSecrets: async () => store, env: {} });
		const withRepo = {
			env: {
				repo: "https://github.com/acme/scratch",
				ref: "main",
				requires: [],
				secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
			},
		};
		expect(await check(withRepo, settings, {})).toEqual({
			ok: true,
			cwd: "/workspace",
			env: {
				CLAUDE_CODE_OAUTH_TOKEN: "oauth",
				GITHUB_APP_ID: "123",
				GITHUB_APP_PRIVATE_KEY: "pem",
				GITHUB_APP_SLUG: "mm-runner",
			},
		});
		// No repo: no git credential. No credential at all: not a missing secret.
		const r = await check(env(["CLAUDE_CODE_OAUTH_TOKEN"]), settings, {});
		expect(r).toMatchObject({
			ok: true,
			env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
		});
		if (r.ok)
			expect(Object.keys(r.env ?? {})).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
		const bare = boxCheck({
			loadSecrets: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" }),
			env: {},
		});
		expect(await bare(withRepo, settings, {})).toMatchObject({ ok: true });
	});
	test("a missing secret declines with its name and the fix", async () => {
		const check = boxCheck({ loadSecrets: async () => ({}), env: {} });
		const r = await check(env(["CLAUDE_CODE_OAUTH_TOKEN"]), settings, {});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toContain("missing secrets: CLAUDE_CODE_OAUTH_TOKEN");
			expect(r.reason).toContain("mastermind-runner secrets set");
		}
	});
});

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
	executionId: "mm-1-x",
	beadId: "mm-1",
	title: "mm-1: t",
	cwd: "/workspace",
	prompt: "p",
	agent: { provider: "claude" },
	env: { TOKEN: "v" },
	recipe: { repo: "https://g/r.git", ref: "main", requires: [] },
	...over,
});

describe("BoxLauncher", () => {
	test("runs the spec in a box: secrets, labels, patch path in the summary", async () => {
		const d = new FakeDriver();
		const steps: string[] = [];
		const l = new BoxLauncher({
			driver: d,
			runnerId: "laptop",
			defaultImage: "img:1",
			outDir: out,
			onStep: (bead, line) => steps.push(`${bead} ${line}`),
		});
		const r = await l.run(spec(), never);
		expect(r.status).toBe("done");
		expect(r.summary).toContain("did it");
		expect(r.summary).toContain(join(out, "mm-1-x.patch"));
		expect(d.created[0]?.labels[BOX_LABEL.runner]).toBe("laptop");
		expect(d.created[0]?.env?.TOKEN).toBe("v");
		expect(steps[0]).toStartWith("mm-1 box ");
		expect(d.boxes.size).toBe(0);
	});
	test("a spec without a recipe is a launch error", async () => {
		const l = new BoxLauncher({
			driver: new FakeDriver(),
			runnerId: "r",
			defaultImage: "i",
		});
		const { recipe: _, ...noRecipe } = spec();
		await expect(l.run(noRecipe, never)).rejects.toBeInstanceOf(LaunchError);
	});
});

describe("startBoxMode", () => {
	test("pings, sweeps boxes an earlier run left, picks the default image", async () => {
		const d = new FakeDriver();
		d.leftover({ [BOX_LABEL.runner]: "laptop" }, "mm-box-old");
		const log: string[] = [];
		const box = await startBoxMode({
			runnerId: "laptop",
			env: { MASTERMIND_BOX_IMAGE: "my/img:2" },
			outDir: out,
			log: (l) => log.push(l),
			driver: d,
		});
		expect(d.boxes.size).toBe(0);
		expect(log.join("\n")).toContain(
			"deleted 1 left from an earlier run: mm-box-old",
		);
		expect(log.join("\n")).toContain("default image my/img:2");
		expect(box.launcher.opts.defaultImage).toBe("my/img:2");
	});
	test("--box-image wins; else the built-in default", async () => {
		const a = await startBoxMode({
			runnerId: "r",
			env: { MASTERMIND_BOX_IMAGE: "x" },
			image: "flag:1",
			outDir: out,
			log: () => {},
			driver: new FakeDriver(),
		});
		expect(a.launcher.opts.defaultImage).toBe("flag:1");
		const b = await startBoxMode({
			runnerId: "r",
			env: {},
			outDir: out,
			log: () => {},
			driver: new FakeDriver(),
		});
		expect(b.launcher.opts.defaultImage).toBe(DEFAULT_BOX_IMAGE);
	});
	test("an engine that does not answer stops the start with the fix", async () => {
		const d = new FakeDriver();
		d.ping = async () => {
			throw new Error("cannot reach the box engine; fix: ... --no-box");
		};
		await expect(
			startBoxMode({
				runnerId: "r",
				env: {},
				outDir: out,
				log: () => {},
				driver: d,
			}),
		).rejects.toThrow("--no-box");
	});
});
