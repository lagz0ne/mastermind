import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentNetwork } from "@mastermind/core";
import type { HostRun } from "../../src/box/devcontainer.ts";
import { BOX_LABEL, type ExecResult } from "../../src/box/driver.ts";
import { CLONE_CRED_DIR, identityEnv } from "../../src/box/output.ts";
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

/** Git on the runner machine (the push), faked: records each command. */
function fakeHost(
	over: (cmd: string[]) => ExecResult | undefined = () => undefined,
) {
	const calls: { cmd: string[]; env: Record<string, string> }[] = [];
	const run: HostRun = async (cmd, o = {}) => {
		calls.push({ cmd, env: o.env ?? {} });
		const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
		const r = over(cmd);
		if (r) return r;
		if (cmd[1] === "rev-parse")
			return ok("f00d000000000000000000000000000000000001\n");
		if (cmd[1] === "rev-list") return ok("2\n");
		if (cmd[1] === "diff") return ok("a\nb\n");
		return ok();
	};
	return { calls, run, lines: () => calls.map((c) => c.cmd.join(" ")) };
}

describe("runInBox: network phases and runtime (mm-210.63)", () => {
	const allowEnv = (over: Partial<BoxTask["env"]> = {}) =>
		task({
			env: {
				...task().env,
				network: { allow: ["api.anthropic.com"] },
				...over,
			},
		});
	test("allow list: the box starts with the setup list; the agent list is set after check and before the agent", async () => {
		const d = new FakeDriver();
		const steps: string[] = [];
		const res = await runInBox(
			allowEnv(),
			{ ...opts(d), onStep: (l) => steps.push(l) },
			never,
		);
		expect(res.status).toBe("done");
		const net = d.created[0]?.network as { allow: string[] };
		expect(net.allow).toContain("api.anthropic.com");
		expect(net.allow).toContain("registry.npmjs.org");
		expect(net.allow).toContain("github.com");
		expect(d.allows).toHaveLength(1);
		expect(d.allows[0]?.allow).toEqual(["api.anthropic.com"]);
		const lines = cmdLines(d);
		const at = d.allows[0]?.afterExecs ?? -1;
		const checkAt = lines.findIndex((l) => l.includes("bun test"));
		const agentAt = lines.findIndex((l) => l.startsWith("paseo run"));
		expect(checkAt).toBeGreaterThanOrEqual(0);
		expect(checkAt).toBeLessThan(at);
		expect(agentAt).toBeGreaterThanOrEqual(at);
		expect(steps).toContain("network: agent phase, only api.anthropic.com");
	});
	test("open network: one phase, no switch; runtime gvisor: the box runs with runsc", async () => {
		const d = new FakeDriver();
		await runInBox(
			task({ env: { ...task().env, runtime: "gvisor" } }),
			opts(d),
			never,
		);
		expect(d.created[0]?.network).toBe("open");
		expect(d.created[0]?.runtime).toBe("runsc");
		expect(d.allows).toHaveLength(0);
		const plain = new FakeDriver();
		await runInBox(task(), opts(plain), never);
		expect(plain.created[0]?.runtime).toBeUndefined();
	});
	test("a box that cannot switch: the agent never starts and the box is deleted", async () => {
		const d = new FakeDriver();
		const create = d.create.bind(d);
		d.create = async (spec) => {
			const b = await create(spec);
			return { ...b, setAllow: undefined };
		};
		await expect(runInBox(allowEnv(), opts(d), never)).rejects.toBeInstanceOf(
			BoxStepError,
		);
		expect(cmdLines(d).some((l) => l.startsWith("paseo run"))).toBe(false);
		expect(d.boxes.size).toBe(0);
	});
});

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
		// secrets: env-safe names as box env; every secret as a file. The
		// model credential goes to the driver (its proxy box), not the box.
		expect(spec?.env).toEqual(BOX_ENV);
		expect(spec?.model).toEqual({
			secret: "CLAUDE_CODE_OAUTH_TOKEN",
			header: "authorization",
			value: `Bearer ${SECRET}`,
		});
		expect(d.copiedIn).toEqual([
			{ box: "box1", dir: SECRETS_DIR, names: ["deploy.key"] },
		]);

		const lines = cmdLines(d);
		const at = (s: string) => lines.findIndex((l) => l.includes(s));
		// the image has user paseo: every step but prepare runs as paseo
		expect(lines.slice(0, 2)).toEqual(["id -u paseo", "id -u"]);
		expect(d.execs[0]?.opts.user).toBe("root");
		expect(at("mkdir -p /workspace")).toBe(2);
		expect(d.execs[2]?.opts.user).toBe("root");
		for (const e of d.execs.slice(3))
			if (!e.cmd.includes(CLONE_CRED_DIR)) expect(e.opts.user).toBe("paseo");
		expect(at(`rm -rf ${CLONE_CRED_DIR}`)).toBeGreaterThan(at("git fetch"));
		expect(at(`rm -rf ${CLONE_CRED_DIR}`)).toBeLessThan(at("bun install"));
		expect(d.execs[at(`rm -rf ${CLONE_CRED_DIR}`)]?.opts.user).toBe("root");
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

	test("model credential (mm-210.70): only to the driver; never box env, a secret file or a ticket line", async () => {
		const networks: EnvironmentNetwork[] = ["open", { allow: ["github.com"] }];
		for (const network of networks) {
			const d = new FakeDriver();
			const base = task();
			const steps: string[] = [];
			await runInBox(
				task({
					env: {
						...base.env,
						network,
					},
					secrets: { ANTHROPIC_API_KEY: "sk-ant-value", OTHER: "o" },
				}),
				{ ...opts(d), onStep: (l) => steps.push(l) },
				never,
			);
			const spec = d.created[0];
			expect(spec?.model).toEqual({
				secret: "ANTHROPIC_API_KEY",
				header: "x-api-key",
				value: "sk-ant-value",
			});
			expect(spec?.env).toEqual({ ...BOX_ENV, OTHER: "o" });
			expect(d.copiedIn[0]?.names).toEqual(["OTHER"]);
			expect(
				JSON.stringify([d.execs, d.copiedIn, steps, spec?.env]),
			).not.toContain("sk-ant-value");
			expect(steps.join("\n")).toContain(
				"ANTHROPIC_API_KEY: stays outside the box",
			);
		}
	});

	test("git credential: only in the env of the clone command; never box env, a secret file or the agent's env", async () => {
		const d = new FakeDriver();
		const base = task();
		const t = task({
			env: { ...base.env, output: { kind: "pr" } },
			secrets: {
				...base.secrets,
				GITHUB_TOKEN: "ghp_value",
				GIT_SSH_KEY: "ssh-key-value",
			},
		});
		const host = fakeHost();
		const fetch = (async (_url: string, init: RequestInit = {}) =>
			init.method === "POST"
				? Response.json({ html_url: "https://github.com/acme/web/pull/3" })
				: Response.json([])) as unknown as typeof globalThis.fetch;
		await runInBox(t, { ...opts(d), fetch, hostRun: host.run }, never);
		const spec = d.created[0];
		expect(spec?.env).toEqual(BOX_ENV);
		expect(d.copiedIn).toEqual([
			{ box: "box1", dir: SECRETS_DIR, names: ["deploy.key"] },
			// the deploy key: in CLONE_CRED_DIR for the clone, then removed
			{ box: "box1", dir: CLONE_CRED_DIR, names: ["key.in"] },
		]);
		const withToken = d.execs.filter((e) =>
			JSON.stringify(e.opts.env ?? {}).includes("ghp_value"),
		);
		expect(withToken.map((e) => e.cmd.join(" "))).toEqual([
			expect.stringContaining("git fetch"),
		]);
		expect(withToken[0]?.opts.env?.GIT_SSH_COMMAND).toContain(
			`-i ${CLONE_CRED_DIR}/key`,
		);
		for (const e of d.execs) {
			expect(e.cmd.join(" ")).not.toContain("ghp_value");
			expect(e.cmd.join(" ")).not.toContain("credential.helper");
		}
		const lines = cmdLines(d);
		const at = (s: string) => lines.findIndex((l) => l.includes(s));
		expect(at(`rm -rf ${CLONE_CRED_DIR}`)).toBe(at("git fetch") + 1);
		expect(at("git rev-parse")).toBeGreaterThan(at(`rm -rf ${CLONE_CRED_DIR}`));
		// the agent's command has no env of its own
		expect(d.execs[at("paseo run")]?.opts.env).toBeUndefined();
	});

	test("output pr: the runner machine pushes mm/<item> after the agent, then the pull request", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "git" && cmd[1] === "rev-list"
				? { code: 0, stdout: "2\n", stderr: "" }
				: undefined;
		const calls: string[] = [];
		const fetch = (async (url: string, init: RequestInit = {}) => {
			calls.push(`${init.method} ${url}`);
			return init.method === "POST"
				? Response.json({ html_url: "https://github.com/acme/web/pull/3" })
				: Response.json([]);
		}) as unknown as typeof globalThis.fetch;
		const base = task();
		const t = task({
			env: { ...base.env, output: { kind: "pr" } },
			secrets: { ...base.secrets, GITHUB_TOKEN: "ghp_value" },
		});
		const host = fakeHost();
		const steps: string[] = [];
		const res = await runInBox(
			t,
			{ ...opts(d), fetch, hostRun: host.run, onStep: (l) => steps.push(l) },
			never,
		);
		expect(res.status).toBe("done");
		expect(res.output?.prUrl).toBe("https://github.com/acme/web/pull/3");
		expect(steps).toContain(res.output?.line ?? "?");
		const lines = cmdLines(d);
		const at = (s: string) => lines.findIndex((l) => l.includes(s));
		// in the box: commit, then a bundle of the new commits; no push
		expect(at("paseo run")).toBeLessThan(at("git bundle create"));
		expect(lines.some((l) => l.includes("git push"))).toBe(false);
		// on the runner machine: the push, with the token only in git's env
		const push = host.calls.find((c) => c.cmd[1] === "push");
		expect(push?.cmd).toEqual([
			"git",
			"push",
			"-q",
			"--force",
			"origin",
			"f00d000000000000000000000000000000000001:refs/heads/mm/mm-1",
		]);
		expect(push?.env.MM_GIT_TOKEN).toBe("ghp_value");
		for (const l of host.lines()) expect(l).not.toContain("ghp_value");
		expect(calls).toEqual([
			"GET https://api.github.com/repos/acme/web/pulls?state=open&head=acme%3Amm%2Fmm-1",
			"POST https://api.github.com/repos/acme/web/pulls",
		]);
		expect(d.boxes.size).toBe(0);
	});

	test("a failing push is tried again alone (3 tries), then fails the task with the reason; the box is deleted", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "git" && cmd[1] === "rev-list"
				? { code: 0, stdout: "1\n", stderr: "" }
				: undefined;
		const host = fakeHost((cmd) =>
			cmd[1] === "push"
				? { code: 128, stdout: "", stderr: "Permission denied" }
				: undefined,
		);
		const base = task();
		const t = task({ env: { ...base.env, output: { kind: "branch" } } });
		const waits: number[] = [];
		const steps: string[] = [];
		const res = await runInBox(
			t,
			{
				...opts(d),
				hostRun: host.run,
				onStep: (l) => steps.push(l),
				outputRetry: {
					attempts: 3,
					waitMs: (n) => {
						waits.push(n);
						return 0;
					},
				},
			},
			never,
		);
		expect(res.status).toBe("failed");
		expect(res.summary).toContain("did it");
		expect(res.summary).toContain(
			"output failed after 3 tries: git push mm/mm-1: exited 128: Permission denied.",
		);
		expect(res.summary).toContain("kept on the runner as a patch:");
		// Mastermind holds the item for a human; no new agent run (mm-2oj).
		expect(res.hold).toBe(true);
		// The agent ran once; the push three times.
		expect(d.execs.filter((e) => e.cmd[1] === "run")).toHaveLength(1);
		expect(host.calls.filter((c) => c.cmd[1] === "push")).toHaveLength(3);
		expect(waits).toEqual([1, 2]);
		expect(steps).toContain(
			"output failed (try 1 of 3): git push mm/mm-1: exited 128: Permission denied; the push alone again in 0 s",
		);
		expect(d.boxes.size).toBe(0);
	});

	test("a push that fails once and then works: the task is done, the agent ran once (mm-210.87)", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "git" && cmd[1] === "rev-list"
				? { code: 0, stdout: "1\n", stderr: "" }
				: undefined;
		let pushes = 0;
		const host = fakeHost((cmd) =>
			cmd[1] === "push" && ++pushes === 1
				? { code: 128, stdout: "", stderr: "Could not resolve host" }
				: undefined,
		);
		const base = task();
		const t = task({ env: { ...base.env, output: { kind: "branch" } } });
		const res = await runInBox(
			t,
			{
				...opts(d),
				hostRun: host.run,
				outputRetry: { attempts: 3, waitMs: () => 0 },
			},
			never,
		);
		expect(res.status).toBe("done");
		expect(res.output?.branch).toBe("mm/mm-1");
		expect(pushes).toBe(2);
		expect(d.execs.filter((e) => e.cmd[1] === "run")).toHaveLength(1);
	});

	test("a failed agent pushes nothing", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[1] === "run"
				? {
						code: 0,
						stdout: JSON.stringify({ status: "failed", summary: "no" }),
						stderr: "",
					}
				: undefined;
		const base = task();
		const t = task({ env: { ...base.env, output: { kind: "pr" } } });
		const host = fakeHost();
		const res = await runInBox(t, { ...opts(d), hostRun: host.run }, never);
		expect(res.output).toBeUndefined();
		expect(cmdLines(d).some((l) => l.includes("git bundle"))).toBe(false);
		expect(host.calls).toEqual([]);
	});
});

describe("runInBox: GitHub App token per task (mm-210.69)", () => {
	const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs1", format: "pem" })
		.toString();
	const HOUR = 60 * 60_000;
	const T0 = Date.parse("2026-11-12T10:00:00Z");
	/** Fake GitHub: installation lookup, token minting (ghs_1, ghs_2, ...), pulls. */
	function fakeGitHub(o: { installed?: boolean } = {}) {
		const calls: {
			method: string;
			url: string;
			auth: string;
			body: unknown;
		}[] = [];
		let minted = 0;
		const fetch = (async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			const auth = String(
				(init.headers as Record<string, string>)?.authorization ??
					(init.headers as Record<string, string>)?.Authorization ??
					"",
			);
			calls.push({
				method,
				url,
				auth,
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.endsWith("/repos/acme/web/installation"))
				return o.installed === false
					? Response.json({ message: "Not Found" }, { status: 404 })
					: Response.json({ id: 77 });
			if (url.endsWith("/users/mm-runner%5Bbot%5D"))
				return Response.json({ login: "mm-runner[bot]", id: 999 });
			if (url.endsWith("/app/installations/77/access_tokens"))
				return Response.json(
					{
						token: `ghs_${++minted}`,
						expires_at: new Date(T0 + HOUR).toISOString(),
					},
					{ status: 201 },
				);
			return method === "POST"
				? Response.json({ html_url: "https://github.com/acme/web/pull/3" })
				: Response.json([]);
		}) as unknown as typeof globalThis.fetch;
		return { calls, fetch, mints: () => minted };
	}
	const appTask = () => {
		const base = task();
		return task({
			env: { ...base.env, output: { kind: "pr" } },
			secrets: {
				...base.secrets,
				GITHUB_APP_ID: "123",
				GITHUB_APP_PRIVATE_KEY: PEM,
				GITHUB_APP_SLUG: "mm-runner",
			},
		});
	};
	const prDriver = () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "git" && cmd[1] === "rev-list"
				? { code: 0, stdout: "1\n", stderr: "" }
				: undefined;
		return d;
	};

	test("one token for the one repo; access check, clone, push and PR API use it; the app key never reaches the box or a log", async () => {
		const d = prDriver();
		const rest = d.handler;
		// The agent left a change uncommitted: the runner commits it in the box.
		d.handler = (cmd, o) =>
			cmd.join(" ") === "git diff --cached --quiet"
				? { code: 1, stdout: "", stderr: "" }
				: rest?.(cmd, o);
		const gh = fakeGitHub();
		const host = fakeHost();
		const steps: string[] = [];
		const prepared: Record<string, string>[] = [];
		const res = await runInBox(
			appTask(),
			{
				...opts(d),
				fetch: gh.fetch,
				hostRun: host.run,
				now: () => T0,
				log: (l) => steps.push(l),
				onStep: (l) => steps.push(l),
				prepare: async (t) => {
					prepared.push(t.secrets);
					return null;
				},
			},
			never,
		);
		expect(res.status).toBe("done");
		expect(gh.mints()).toBe(1);
		const mint = gh.calls.find((c) => c.url.endsWith("/access_tokens"));
		expect(mint?.body).toEqual({
			repositories: ["web"],
			permissions: { contents: "write", pull_requests: "write" },
		});
		expect(mint?.auth).toMatch(/^Bearer ey/); // the app JWT, not the key
		// the access check (prepare) gets the token, not the app key
		expect(prepared[0]?.GIT_TOKEN).toBe("ghs_1");
		expect(prepared[0]?.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
		// the clone: the token only in the env of that one command
		const clone = d.execs.find((e) => e.cmd.join(" ").includes("git fetch"));
		expect(clone?.opts.env?.MM_GIT_TOKEN).toBe("ghs_1");
		// the push on this machine and the PR API
		expect(host.calls.find((c) => c.cmd[1] === "push")?.env.MM_GIT_TOKEN).toBe(
			"ghs_1",
		);
		const pr = gh.calls.filter((c) => c.url.includes("/pulls"));
		expect(pr.map((c) => c.auth)).toEqual(["Bearer ghs_1", "Bearer ghs_1"]);
		expect(res.output?.prUrl).toBe("https://github.com/acme/web/pull/3");
		// commits by the App's bot, never by a person (mm-210.87): the box's
		// git identity and the commit of what the agent left
		const bot = {
			name: "mm-runner[bot]",
			email: "999+mm-runner[bot]@users.noreply.github.com",
		};
		expect(gh.calls.find((c) => c.url.includes("/users/"))?.auth).toBe(
			"Bearer ghs_1",
		);
		const commit = d.execs.find((e) => e.cmd.includes("commit"));
		expect(commit?.cmd).toContain(`user.name=${bot.name}`);
		expect(commit?.cmd).toContain(`user.email=${bot.email}`);
		expect(steps).toContain(`commits by ${bot.name} <${bot.email}>`);
		// never in the box (env, files, argv) nor in a log or ticket line
		expect(d.created[0]?.env).toEqual({ ...BOX_ENV, ...identityEnv(bot) });
		expect(d.copiedIn[0]?.names).toEqual(["deploy.key"]);
		const everything = JSON.stringify([
			d.created,
			d.copiedIn,
			d.execs.map((e) => e.cmd),
			host.lines(),
			steps,
		]);
		for (const v of ["PRIVATE KEY", PEM.slice(40, 80), "ghs_1"])
			expect(everything).not.toContain(v);
		expect(steps).toContain(
			"GitHub App token for acme/web (contents, pull requests write) until 11:00 UTC",
		);
	});

	test("a long task: under 10 min left, a new token is minted for the push", async () => {
		const d = prDriver();
		const gh = fakeGitHub();
		const host = fakeHost();
		let clock = T0;
		d.handler = (cmd) => {
			if (cmd[1] === "run") clock = T0 + HOUR - 5 * 60_000;
			return cmd[0] === "git" && cmd[1] === "rev-list"
				? { code: 0, stdout: "1\n", stderr: "" }
				: undefined;
		};
		const res = await runInBox(
			appTask(),
			{ ...opts(d), fetch: gh.fetch, hostRun: host.run, now: () => clock },
			never,
		);
		expect(res.status).toBe("done");
		expect(gh.mints()).toBe(2);
		const clone = d.execs.find((e) => e.cmd.join(" ").includes("git fetch"));
		expect(clone?.opts.env?.MM_GIT_TOKEN).toBe("ghs_1");
		expect(host.calls.find((c) => c.cmd[1] === "push")?.env.MM_GIT_TOKEN).toBe(
			"ghs_2",
		);
		const pr = gh.calls.filter((c) => c.url.includes("/pulls"));
		expect(pr.map((c) => c.auth)).toEqual(["Bearer ghs_2", "Bearer ghs_2"]);
	});

	test("the app is not installed on the repo: no box, the reason names the fix", async () => {
		const d = prDriver();
		const gh = fakeGitHub({ installed: false });
		const err = await runInBox(
			appTask(),
			{ ...opts(d), fetch: gh.fetch, hostRun: fakeHost().run },
			never,
		).catch((e) => e);
		expect(err).toBeInstanceOf(BoxStepError);
		expect(err.message).toContain(
			"the GitHub App is not installed on acme/web",
		);
		expect(d.created).toEqual([]);
	});

	test("no app secrets: no token is minted; the GIT_TOKEN way is unchanged", async () => {
		const d = prDriver();
		const gh = fakeGitHub();
		const host = fakeHost();
		const base = task();
		const t = task({
			env: { ...base.env, output: { kind: "pr" } },
			secrets: { ...base.secrets, GIT_TOKEN: "github_pat_x" },
		});
		await runInBox(
			t,
			{ ...opts(d), fetch: gh.fetch, hostRun: host.run },
			never,
		);
		expect(gh.mints()).toBe(0);
		expect(gh.calls.some((c) => c.url.includes("installation"))).toBe(false);
		expect(host.calls.find((c) => c.cmd[1] === "push")?.env.MM_GIT_TOKEN).toBe(
			"github_pat_x",
		);
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
