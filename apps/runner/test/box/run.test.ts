import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_LABEL } from "../../src/box/driver.ts";
import {
	BOX_ENV,
	BoxStepError,
	type BoxTask,
	paseoRun,
	runInBox,
	SECRETS_DIR,
	sweepBoxes,
} from "../../src/box/run.ts";
import { LaunchError } from "../../src/launcher.ts";
import { FakeDriver } from "./fake-driver.ts";

const out = mkdtempSync(join(tmpdir(), "mm-box-test-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const SECRET = "s3cr3t-value";
let n = 0;
function task(over: Partial<BoxTask> = {}): BoxTask {
	return {
		executionId: `mm-1-${++n}`,
		beadId: "mm-1",
		runnerId: "laptop",
		title: "mm-1: fix it",
		prompt: "fix the bug",
		env: {
			name: "web",
			repo: "https://github.com/acme/web.git",
			ref: "main",
			requires: [],
			image: "",
			tools: ["apt-get install -y jq"],
			recipeHash: "h1",
			setup: ["bun install"],
			check: ["bun test"],
			limits: { cpu: 2, memoryMb: 2048, timeoutMin: 60 },
			network: "open",
		},
		agent: { provider: "claude" },
		secrets: { CLAUDE_CODE_OAUTH_TOKEN: SECRET, "deploy.key": "k" },
		...over,
	};
}
const never = new AbortController().signal;
const opts = (driver: FakeDriver) => ({
	driver,
	defaultImage: "ghcr.io/getpaseo/paseo:0.15.4",
	outDir: out,
});
const cmdLines = (d: FakeDriver) => d.execs.map((e) => e.cmd.join(" "));

describe("runInBox", () => {
	test("makes, fills, runs, takes out and deletes the box", async () => {
		const d = new FakeDriver();
		const steps: string[] = [];
		const t = task();
		const res = await runInBox(
			t,
			{ ...opts(d), onStep: (l) => steps.push(l) },
			never,
		);
		expect(res.status).toBe("done");
		expect(res.summary).toBe("did it");
		expect(res.patch).toBe(join(out, `${t.executionId}.patch`));
		expect(readFileSync(res.patch ?? "", "utf8")).toBe(d.patch);

		// image: default base + tools, cache key = recipeHash
		expect(d.images).toEqual([
			{
				image: "ghcr.io/getpaseo/paseo:0.15.4",
				tools: ["apt-get install -y jq"],
				hash: "h1",
			},
		]);
		const spec = d.created[0];
		expect(spec?.image).toBe("built:h1");
		expect(spec?.labels).toEqual({
			[BOX_LABEL.runner]: "laptop",
			[BOX_LABEL.item]: "mm-1",
			[BOX_LABEL.execution]: t.executionId,
		});
		expect(spec?.limits).toEqual({ cpu: 2, memoryMb: 2048 });
		expect(spec?.network).toBe("open");
		// secrets: env-safe names as box env; every secret as a file
		expect(spec?.env).toEqual({ ...BOX_ENV, CLAUDE_CODE_OAUTH_TOKEN: SECRET });
		expect(d.copiedIn).toEqual([
			{
				box: "box1",
				dir: SECRETS_DIR,
				names: ["CLAUDE_CODE_OAUTH_TOKEN", "deploy.key"],
			},
		]);

		const lines = cmdLines(d);
		const at = (s: string) => lines.findIndex((l) => l.includes(s));
		// the image has user paseo: every step but prepare runs as paseo
		expect(lines.slice(0, 2)).toEqual(["id -u paseo", "id -u"]);
		expect(d.execs[0]?.opts.user).toBe("root");
		expect(at("mkdir -p /workspace")).toBe(2);
		expect(d.execs[2]?.opts.user).toBe("root");
		for (const e of d.execs.slice(3)) expect(e.opts.user).toBe("paseo");
		expect(at("git fetch")).toBeLessThan(at("bun install"));
		expect(at("bun install")).toBeLessThan(at("bun test"));
		expect(at("bun test")).toBeLessThan(at("paseo status"));
		expect(at("paseo status")).toBeLessThan(at("paseo run"));
		expect(at("paseo run")).toBeLessThan(at("git diff --cached"));
		// repo and ref are arguments, not part of the script
		const clone = d.execs.find((e) => e.cmd.join(" ").includes("git fetch"));
		expect(clone?.cmd.slice(-2)).toEqual([
			"https://github.com/acme/web.git",
			"main",
		]);
		// no secret value in any command line
		for (const l of lines) expect(l).not.toContain(SECRET);
		expect(d.boxes.size).toBe(0);
		expect(steps.at(-1)).toContain("deleted");
	});

	test("an image without user paseo: steps run as the image's user", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd.join(" ") === "id -u paseo"
				? { code: 1, stdout: "", stderr: "no such user" }
				: undefined;
		await runInBox(task(), opts(d), never);
		expect(d.execs.at(-1)?.opts.user).toBeUndefined();
	});

	test("an environment image is used as is when it has no tools", async () => {
		const d = new FakeDriver();
		const base = task();
		await runInBox(
			task({ env: { ...base.env, image: "node:24", tools: [] } }),
			opts(d),
			never,
		);
		expect(d.created[0]?.image).toBe("node:24");
	});

	test("a failing setup stops before the agent, with the output tail, and deletes the box", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd.at(-1) === "bun install"
				? { code: 1, stdout: "resolving\n", stderr: "error: lockfile\n" }
				: undefined;
		const err = await runInBox(task(), opts(d), never).catch((e) => e);
		expect(err).toBeInstanceOf(BoxStepError);
		expect(err).toBeInstanceOf(LaunchError);
		expect(err.message).toContain("setup `bun install` exited 1");
		expect(err.message).toContain("error: lockfile");
		expect(cmdLines(d).some((l) => l.startsWith("paseo run"))).toBe(false);
		expect(d.boxes.size).toBe(0);
	});

	test("a failing check stops before the agent", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd.at(-1) === "bun test"
				? { code: 2, stdout: "", stderr: "1 fail" }
				: undefined;
		const err = await runInBox(task(), opts(d), never).catch((e) => e);
		expect(err.message).toContain("check `bun test` exited 2: 1 fail");
		expect(d.boxes.size).toBe(0);
	});

	test("waits for the agent host in the box", async () => {
		const d = new FakeDriver();
		let tries = 0;
		d.handler = (cmd) =>
			cmd[1] === "status" && ++tries < 3
				? { code: 1, stdout: "", stderr: "not running" }
				: undefined;
		const res = await runInBox(task(), opts(d), never);
		expect(res.status).toBe("done");
		expect(tries).toBe(3);
	});

	test("an agent host that never gets ready is a start failure with the box log", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[1] === "status"
				? { code: 1, stdout: "", stderr: "not running" }
				: undefined;
		const err = await runInBox(
			task(),
			{ ...opts(d), readyTimeoutMs: 50 },
			never,
		).catch((e) => e);
		expect(err).toBeInstanceOf(BoxStepError);
		expect(err.message).toContain("not ready: not running");
		expect(err.message).toContain("daemon log");
		expect(d.boxes.size).toBe(0);
	});

	test("a failing paseo run gives paseo's error and deletes the box", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[1] === "run"
				? {
						code: 1,
						stdout: JSON.stringify({
							error: { code: "AUTH", message: "not logged in" },
						}),
						stderr: "",
					}
				: undefined;
		const err = await runInBox(task(), opts(d), never).catch((e) => e);
		expect(err).toBeInstanceOf(LaunchError);
		expect(err.message).toContain("AUTH: not logged in");
		expect(d.boxes.size).toBe(0);
	});

	test("stop while the agent runs deletes the box at once", async () => {
		const d = new FakeDriver();
		const stop = new AbortController();
		d.handler = async (cmd) => {
			if (cmd[1] !== "run") return undefined;
			stop.abort();
			await Bun.sleep(10);
			return { code: 0, stdout: "{}", stderr: "" };
		};
		const err = await runInBox(task(), opts(d), stop.signal).catch((e) => e);
		expect(err).toBeInstanceOf(LaunchError);
		expect(err.message).toBe("agent stopped");
		expect(d.boxes.size).toBe(0);
	});

	test("the environment timeout stops the task and deletes the box", async () => {
		const d = new FakeDriver();
		d.handler = async (cmd) => {
			if (cmd[1] === "run") await Bun.sleep(300);
			return undefined;
		};
		const base = task();
		const t = task({
			env: {
				...base.env,
				limits: { cpu: 1, memoryMb: 512, timeoutMin: 0.001 },
			},
		});
		const err = await runInBox(t, opts(d), never).catch((e) => e);
		expect(err.message).toBe("box timed out after 0.001 min");
		expect(d.boxes.size).toBe(0);
	});

	test("a box that cannot be made is a start failure; nothing is left", async () => {
		const d = new FakeDriver();
		d.createError = new Error("network allow lists are not supported");
		const err = await runInBox(task(), opts(d), never).catch((e) => e);
		expect(err).toBeInstanceOf(BoxStepError);
		expect(err.message).toContain("allow lists");
	});

	test("no repo: no checkout and no patch", async () => {
		const d = new FakeDriver();
		const base = task();
		const res = await runInBox(
			task({ env: { ...base.env, repo: "", setup: [], check: [] } }),
			opts(d),
			never,
		);
		expect(res.patch).toBeUndefined();
		expect(cmdLines(d).some((l) => l.includes("git"))).toBe(false);
	});

	test("a fake agent command and no ready wait", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "fake-agent"
				? { code: 0, stdout: '{"status":"failed","summary":"no"}', stderr: "" }
				: undefined;
		const res = await runInBox(
			task(),
			{ ...opts(d), agentCommand: () => ["fake-agent"], readyCommand: null },
			never,
		);
		expect(res).toMatchObject({ status: "failed", summary: "no" });
		expect(cmdLines(d).some((l) => l.startsWith("paseo"))).toBe(false);
	});
});

describe("paseoRun", () => {
	test("bypass mode by default, provider, labels, cwd /workspace", () => {
		const args = paseoRun(task());
		const after = (f: string) => args[args.indexOf(f) + 1];
		expect(after("--mode")).toBe("bypassPermissions");
		expect(after("--provider")).toBe("claude");
		expect(after("--cwd")).toBe("/workspace");
		expect(args).toContain("mastermind.bead=mm-1");
		expect(args.at(-1)).toBe("fix the bug");
		expect(args.join(" ")).not.toContain(SECRET);
	});
	test("the runner's mode wins", () => {
		const args = paseoRun(task({ agent: { provider: "codex", mode: "full" } }));
		expect(args[args.indexOf("--mode") + 1]).toBe("full");
	});
});

describe("sweepBoxes", () => {
	test("deletes this runner's boxes that are not in flight, and no others", async () => {
		const d = new FakeDriver();
		const dead = d.leftover(
			{ [BOX_LABEL.runner]: "laptop", [BOX_LABEL.execution]: "mm-1-a" },
			"dead",
		);
		const live = d.leftover({
			[BOX_LABEL.runner]: "laptop",
			[BOX_LABEL.execution]: "mm-2-b",
		});
		const other = d.leftover({
			[BOX_LABEL.runner]: "desktop",
			[BOX_LABEL.execution]: "mm-3-c",
		});
		const gone = await sweepBoxes(d, "laptop", new Set(["mm-2-b"]));
		expect(gone).toEqual(["dead"]);
		expect(d.removed).toEqual([dead]);
		expect(d.boxes.has(live)).toBe(true);
		expect(d.boxes.has(other)).toBe(true);
	});
});
