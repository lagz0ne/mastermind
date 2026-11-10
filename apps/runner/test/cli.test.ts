import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFlags, EXIT, main, runnerInfo, VERSION } from "../src/cli.ts";
import {
	configPath,
	defaultSettings,
	loadConfig,
	modeOf,
} from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "mm-runner-cli-"));
let server: ReturnType<typeof Bun.serve>;
const used = new Set<string>();

beforeAll(() => {
	// Mimics POST /api/auth/enrol of apps/api (single-use tokens).
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		routes: {
			"/api/auth/enrol": {
				POST: async (req) => {
					const { token } = (await req.json()) as { token: string };
					if (!token.startsWith("mme_") || used.has(token))
						return Response.json(
							{ error: "token is invalid or used" },
							{ status: 401 },
						);
					used.add(token);
					return Response.json(
						{
							account: "alice",
							serviceAccount: {
								id: "0a1b2c",
								account: "alice",
								name: "laptop",
							},
							credential: "mms_alice_0a1b2c_secret",
							natsUrl: "ws://127.0.0.1:1",
							inboxPrefix: "_INBOX.alice",
						},
						{ status: 201 },
					);
				},
			},
		},
	});
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

function io(env: Record<string, string> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: {
			env: { MASTERMIND_RUNNER_CONFIG: join(dir, "c", "runner.json"), ...env },
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
			cwd: "/home/u/src",
		},
	};
}

test("configPath: env, then XDG, then ~/.config", () => {
	expect(configPath({ MASTERMIND_RUNNER_CONFIG: "/x.json" })).toBe("/x.json");
	expect(configPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
		"/xdg/mastermind/runner.json",
	);
	expect(configPath({})).toEndWith("/.config/mastermind/runner.json");
});

test("applyFlags", () => {
	const s = applyFlags(
		defaultSettings("laptop"),
		{
			queue: ["a", "b"],
			capacity: "3",
			capability: ["git"],
			providers: "claude, codex",
			workdir: "work",
			repo: ["https://g/o/r=r"],
			provider: "claude",
			mode: "bypassPermissions",
			"assistant-provider": "claude/claude-haiku-5-5",
		},
		"/home/u",
	);
	expect(s).toMatchObject({
		queues: ["a", "b"],
		capacity: 3,
		capabilities: ["git"],
		providers: ["claude", "codex"],
		workdir: "/home/u/work",
		repos: { "https://g/o/r": "/home/u/r" },
		agent: { provider: "claude", mode: "bypassPermissions" },
		assistant: { provider: "claude/claude-haiku-5-5" },
	});
	expect(() => applyFlags(defaultSettings("x"), { capacity: "0" })).toThrow();
});

describe("enroll, status, check", () => {
	test("start before enroll is a usage error", async () => {
		const t = io();
		expect(await main(["start"], t.io)).toBe(EXIT.usage);
		expect(t.err[0]).toContain("not enrolled");
	});

	test("enroll needs a Mastermind URL from a flag or the env", async () => {
		const t = io();
		expect(await main(["enroll", "mme_a"], t.io)).toBe(EXIT.usage);
		expect(t.err[0]).toContain("MASTERMIND_URL");
	});

	test("enroll stores the credential with mode 0600", async () => {
		const t = io({ MASTERMIND_URL: `${server.url}` });
		const code = await main(
			["enroll", "mme_one", "--queue", "backend", "--workdir", "w"],
			t.io,
		);
		expect(code).toBe(EXIT.ok);
		const path = t.io.env.MASTERMIND_RUNNER_CONFIG;
		expect(await modeOf(path)).toBe(0o600);
		const cfg = await loadConfig(path);
		expect(cfg).toMatchObject({
			account: "alice",
			credential: "mms_alice_0a1b2c_secret",
			inboxPrefix: "_INBOX.alice",
			natsUrl: "ws://127.0.0.1:1",
			state: "active",
			runner: { id: "laptop", queues: ["backend"], workdir: "/home/u/src/w" },
		});
		expect(cfg?.mastermindUrl).toBe(server.url.href.replace(/\/$/, ""));
	});

	test("a second enroll needs --force; a used token fails", async () => {
		const t = io({ MASTERMIND_URL: `${server.url}` });
		expect(await main(["enroll", "mme_two"], t.io)).toBe(EXIT.usage);
		const u = io({ MASTERMIND_URL: `${server.url}` });
		expect(await main(["enroll", "mme_one", "--force"], u.io)).toBe(EXIT.error);
		expect(u.err[0]).toContain("enrol failed (401)");
	});

	test("status never prints the credential", async () => {
		const t = io();
		expect(await main(["status"], t.io)).toBe(EXIT.ok);
		expect(t.out.join("\n")).not.toContain("secret");
	});

	test("check reports missing capabilities", async () => {
		const t = io();
		const code = await main(["check", "--capability", "no-such-tool-mm"], t.io);
		expect(code).toBe(EXIT.error);
		expect(t.out[0]).toBe("✗ no-such-tool-mm: not on PATH");
	});

	test("a corrupt config is moved aside", async () => {
		const path = join(dir, "bad", "runner.json");
		rmSync(join(dir, "bad"), { recursive: true, force: true });
		mkdirSync(join(dir, "bad"));
		writeFileSync(path, "{not json");
		const t = io({ MASTERMIND_RUNNER_CONFIG: path });
		expect(await main(["start"], t.io)).toBe(EXIT.error);
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(join(dir, "bad"))[0]).toStartWith(
			"runner.json.corrupt-",
		);
	});
});

test("runnerInfo announces the runner with its capacity and queues", async () => {
	const cfg = await loadConfig(join(dir, "c", "runner.json"));
	if (!cfg) throw new Error("no config");
	const s = { ...cfg.runner, capacity: 2, queues: ["a", "b"] };
	expect(runnerInfo(cfg, s)).toMatchObject({
		id: "laptop",
		account: "alice",
		serviceAccount: "0a1b2c",
		capacity: 2,
		queues: ["a", "b"],
	});
});

test("--version and version print the build version", async () => {
	for (const argv of [["--version"], ["-v"], ["version"]]) {
		const o = io();
		expect(await main(argv, o.io)).toBe(EXIT.ok);
		expect(o.out).toEqual([VERSION]);
	}
});
