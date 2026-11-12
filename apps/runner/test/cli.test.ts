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
import {
	applyFlags,
	capacityText,
	EXIT,
	main,
	runnerInfo,
	VERSION,
} from "../src/cli.ts";
import {
	configPath,
	defaultSettings,
	loadConfig,
	modeOf,
	parseConfig,
} from "../src/config.ts";
import { parseRouting } from "../src/routing.ts";

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
	expect(() => applyFlags(defaultSettings("x"), { capacity: "-1" })).toThrow();
	expect(() =>
		applyFlags(defaultSettings("x"), { capacity: "lots" }),
	).toThrow();
});

test("--capacity unlimited (or 0) is null", () => {
	for (const v of ["unlimited", "0"])
		expect(applyFlags(defaultSettings("x"), { capacity: v }).capacity).toBe(
			null,
		);
	expect(capacityText(null)).toBe("unlimited");
	expect(capacityText(2)).toBe("2");
});

test("runner.json keeps capacity null (unlimited) and a number; refuses 0", () => {
	const file = (capacity: unknown) => ({
		version: 1,
		mastermindUrl: "https://mm.example",
		natsUrl: "wss://nats.example",
		account: "alice",
		credential: "c",
		inboxPrefix: "_INBOX.alice",
		enrolledAt: "2026-11-11T00:00:00.000Z",
		serviceAccount: { id: "sa1", name: "laptop" },
		state: "active",
		runner: { id: "laptop", capacity },
	});
	expect(parseConfig(file(null)).runner.capacity).toBe(null);
	expect(parseConfig(file(4)).runner.capacity).toBe(4);
	expect(() => parseConfig(file(0))).toThrow();
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

	test("status shows the runner's last status.json; --json too", async () => {
		const path = join(dir, "c", "status.json");
		writeFileSync(
			path,
			JSON.stringify({
				runner: "laptop",
				version: "dev",
				at: new Date().toISOString(),
				state: "connected",
				natsServer: "wss://nats.example:443",
				reconnects: 2,
				queues: ["backend"],
				capacity: 1,
				running: 1,
				inFlight: [
					{
						itemId: "mm-1",
						queue: "backend",
						stage: "work",
						target: "local",
						startedAt: "2026-11-11T00:00:00.000Z",
						paseoAgentId: null,
					},
				],
				lastNextAt: null,
				lastNextResult: "dispatch",
				lastDecision: "mm-1: target local",
				checks: {
					paseo: false,
					providers: { claude: false },
					workdir: true,
					checkedAt: null,
				},
				lastErrors: ["next backend: timeout"],
			}),
		);
		const t = io();
		expect(await main(["status"], t.io)).toBe(EXIT.ok);
		const text = t.out.join("\n");
		expect(text).toContain("connected, nats wss://nats.example:443");
		expect(text).toContain("mm-1 backend/work target local");
		expect(text).toContain("paseo ✗");
		expect(text).toContain("next backend: timeout");
		expect(text).not.toContain("STALE");
		const j = io();
		expect(await main(["status", "--json"], j.io)).toBe(EXIT.ok);
		const parsed = JSON.parse(j.out.join("\n"));
		expect(parsed.diagnostics.reconnects).toBe(2);
		expect(parsed.stale).toBe(false);
		expect(j.out.join("\n")).not.toContain("secret");
		rmSync(path);
	});

	test("doctor names each problem with a fix", async () => {
		// DOCKER_HOST: never the real engine of the test host (a pull would hang the test).
		const t = io({
			MASTERMIND_URL: "http://127.0.0.1:1",
			DOCKER_HOST: "tcp://127.0.0.1:1",
		});
		const code = await main(
			["doctor", "--workdir", "/no/such/dir-mm", "--paseo-host", "127.0.0.1:1"],
			t.io,
		);
		expect(code).toBe(EXIT.error);
		const text = t.out.join("\n");
		expect(text).toContain("FAIL a. config");
		expect(text).toContain("Mastermind does not answer");
		expect(text).toContain("FAIL d. paseo");
		expect(text).toContain("workdir /no/such/dir-mm does not exist");
		expect(text).toContain("fix:");
		expect(text).toContain("SKIP e. agent");
		expect(text).toContain("FAIL g. box");
		expect(text).toContain("--no-box at your own risk");
	});

	test("doctor --no-box skips the box step", async () => {
		const t = io({ MASTERMIND_URL: "http://127.0.0.1:1" });
		await main(
			[
				"doctor",
				"--no-box",
				"--workdir",
				"/no/such/dir-mm",
				"--paseo-host",
				"127.0.0.1:1",
			],
			t.io,
		);
		expect(t.out.join("\n")).toContain("SKIP g. box");
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

describe("route and check with routing.json", () => {
	const routingDir = mkdtempSync(join(tmpdir(), "mm-routing-"));
	const file = join(routingDir, "routing.json");
	writeFileSync(
		file,
		JSON.stringify({
			targets: {
				laptop: { provider: "claude" },
				gpu: { paseoHost: "gpu-box:6767", provider: "codex" },
			},
			environments: { web: { dir: routingDir }, ml: { dir: routingDir } },
			rules: [
				{ match: { labels: ["secret"] }, decline: "not here" },
				{ match: { env: "ml" }, target: "gpu" },
				{ match: { queue: "q" }, target: "laptop" },
			],
		}),
	);
	const env = { MASTERMIND_RUNNER_ROUTING: file };

	test("route prints the target and why", async () => {
		const t = io(env);
		const code = await main(["route", "--env", "ml", "--queue", "q"], t.io);
		expect(code).toBe(EXIT.ok);
		expect(t.out[0]).toBe(
			"target gpu on gpu-box:6767, provider codex (runner laptop, rule 2)",
		);
		expect(t.out).toContain(`checkout ${routingDir}`);
		expect(t.out).toContain("  rule 1 skipped: no label secret");
	});

	test("route reads a dispatch file; a decline exits 1 with the reason", async () => {
		const d = join(routingDir, "d.json");
		writeFileSync(
			d,
			JSON.stringify({
				queue: "q",
				stage: "work",
				env: { name: "mobile", repo: "", ref: "", requires: [] },
			}),
		);
		const t = io(env);
		expect(await main(["route", d], t.io)).toBe(EXIT.error);
		expect(t.out[0]).toBe(
			"decline: environment mobile is not bound on this runner",
		);
		const s = io(env);
		expect(
			await main(["route", d, "--env", "web", "--label", "secret"], s.io),
		).toBe(EXIT.error);
		expect(s.out[0]).toBe("decline: declined by rule 1: not here");
	});

	test("check validates the routing for the runner's queues", async () => {
		const t = io(env);
		const code = await main(["check", "--queue", "other"], t.io);
		expect(code).toBe(EXIT.error);
		expect(t.out).toContain(
			"✗ rule 3: queue q is not one of this runner's queues",
		);
		expect(t.out.join("\n")).toContain(
			`routing ${file}: 2 targets, 3 rules, environments web,ml`,
		);
		const ok = io(env);
		expect(await main(["check", "--queue", "q"], ok.io)).toBe(EXIT.ok);
	});

	test("runnerInfo lists the bound environments", async () => {
		const cfg = await loadConfig(join(dir, "c", "runner.json"));
		if (!cfg) throw new Error("no config");
		const routing = parseRouting({ environments: { web: { dir: "/w" } } });
		expect(runnerInfo(cfg, cfg.runner, routing).environments).toEqual(["web"]);
		expect(runnerInfo(cfg, cfg.runner).environments).toBeUndefined();
	});
});
