import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { BoxError } from "../src/box/driver.ts";
import type { RunnerConfig, RunnerSettings } from "../src/config.ts";
import {
	asksPermission,
	type DoctorDeps,
	type DoctorInput,
	type DoctorNats,
	type DoctorReport,
	type DoctorStep,
	formatReport,
	paseoCommandLine,
	paseoError,
	runDoctor,
} from "../src/doctor.ts";
import {
	type AgentSpec,
	LaunchError,
	PROVIDER_LOGIN_FIX,
	runFailure,
} from "../src/launcher.ts";
import { implicitRouting } from "../src/routing.ts";
import { FakeDriver } from "./box/fake-driver.ts";
import { fakeAnthropic, GOOD_TOKEN } from "./fake-anthropic.ts";

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	id: "laptop",
	queues: ["backend"],
	capacity: 1,
	capabilities: [],
	providers: ["claude"],
	workdir: tmpdir(),
	repos: {},
	agent: { provider: "claude", mode: "auto" },
	allowSetup: false,
	...over,
});

const config = (s: RunnerSettings): RunnerConfig => ({
	version: 1,
	mastermindUrl: "https://mm.example",
	natsUrl: "wss://nats.example",
	account: "alice",
	serviceAccount: { id: "0a1b2c", name: "laptop" },
	credential: "mms_alice_0a1b2c_secret",
	inboxPrefix: "_INBOX.alice",
	state: "active",
	enrolledAt: "",
	runner: s,
});

const input = (
	over: Partial<DoctorInput> = {},
	s = settings(),
): DoctorInput => ({
	config: config(s),
	configPath: "/cfg/runner.json",
	settings: s,
	routing: implicitRouting(s),
	routingSource: "flags",
	version: "abc123",
	deep: false,
	...over,
});

type World = {
	credential?: number;
	server?: string;
	connect?: DoctorDeps["connect"];
	providers?: unknown[];
	run?: (
		spec: AgentSpec,
	) => Promise<{ status: "done" | "failed"; summary: string }>;
};

/** Fakes for every outside call; records what happened. */
function world(w: World = {}) {
	const calls = {
		paseo: [] as string[][],
		specs: [] as AgentSpec[],
		published: [] as string[],
	};
	let started = 0;
	const deps: DoctorDeps = {
		fetch: (async (url: string) =>
			String(url).endsWith("/api/health")
				? Response.json({ version: w.server ?? "abc123" })
				: new Response(null, {
						status: w.credential ?? 200,
					})) as unknown as typeof fetch,
		connect:
			w.connect ??
			(async () =>
				({
					getServer: () => "nats.example:443",
					publish: (s: string) => calls.published.push(s),
					flush: async () => {},
					close: async () => {},
				}) satisfies DoctorNats),
		paseo: async (args) => {
			calls.paseo.push(args);
			if (args[0] === "provider")
				return {
					code: 0,
					stdout: JSON.stringify(
						w.providers ?? [
							{ provider: "claude", status: "available", defaultMode: "auto" },
						],
					),
					stderr: "",
				};
			return { code: 0, stdout: "[]", stderr: "" };
		},
		launcher: {
			async run(spec) {
				calls.specs.push(spec);
				started++;
				return w.run ? w.run(spec) : { status: "done", summary: "OK" };
			},
			async find() {
				return started ? ["agent-1"] : [];
			},
		},
		isGitDir: async () => true,
		now: () => new Date("2026-11-11T07:00:00Z"),
	};
	return { deps, calls };
}

const step = (r: DoctorReport, id: string): DoctorStep => {
	const s = r.steps.find((x) => x.id === id);
	if (!s) throw new Error(`no step ${id}`);
	return s;
};

describe("runner doctor", () => {
	test("a healthy runner passes every step, and --deep runs and archives a probe agent", async () => {
		const { deps, calls } = world();
		const r = await runDoctor(input({ deep: true }), deps);
		expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
			"a:pass",
			"b:pass",
			"c:pass",
			"d:pass",
			"e:pass",
		]);
		expect(r.ok).toBe(true);
		expect(calls.published).toEqual(["mm.u.alice.r.laptop.status"]);
		const spec = calls.specs[0] as AgentSpec;
		expect(spec.title).toStartWith("probe:");
		expect(spec.labels).toMatchObject({
			purpose: "probe",
			"mastermind.doctor": "1",
		});
		expect(spec.agent).toEqual({ provider: "claude", mode: "auto" });
		expect(calls.paseo).toContainEqual(["archive", "--force", "agent-1"]);
		expect(step(r, "c").detail.join("\n")).toContain(
			"--provider claude --mode auto",
		);
		const text = formatReport(r).join("\n");
		expect(text).toContain("PASS e. agent");
		expect(text).not.toContain("secret");
	});

	test("without --deep no agent starts", async () => {
		const { deps, calls } = world();
		const r = await runDoctor(input(), deps);
		expect(step(r, "e").status).toBe("skip");
		expect(calls.specs).toHaveLength(0);
	});

	test("MISSING_PROVIDER: step e fails with the Paseo error and an update fix, the probe is archived", async () => {
		const { deps, calls } = world({
			run: async () => {
				throw new LaunchError(
					"paseo run exited 1: MISSING_PROVIDER: Provider is required",
				);
			},
		});
		const r = await runDoctor(input({ deep: true }), deps);
		const e = step(r, "e");
		expect(e.status).toBe("fail");
		expect(e.detail.join("\n")).toContain("MISSING_PROVIDER");
		expect(e.fix).toContain("https://mm.example/install.sh");
		expect(r.ok).toBe(false);
		expect(calls.paseo).toContainEqual(["archive", "--force", "agent-1"]);
	});

	test("an agent waiting for permission: step e fails with a mode fix", async () => {
		const { deps } = world({
			run: async () => {
				throw new LaunchError(
					"paseo run exited 1: OUTPUT_SCHEMA_FAILED: Agent is waiting for permission before producing structured output",
				);
			},
		});
		const e = step(await runDoctor(input({ deep: true }), deps), "e");
		expect(e.status).toBe("fail");
		expect(e.fix).toContain("--mode auto");
	});

	test("a probe agent that cannot log in: step e fails with the login fix (mm-210.72)", async () => {
		const { deps } = world({
			run: async () => {
				throw new LaunchError(
					runFailure({
						code: 1,
						stdout: JSON.stringify({
							error: {
								code: "OUTPUT_SCHEMA_FAILED",
								message:
									"Agent response did not match the required output schema",
								details:
									"Invalid JSON: Unexpected token 'N', \"Not logged\"... is not valid JSON",
							},
						}),
						stderr: "",
					}),
				);
			},
		});
		const r = await runDoctor(input({ deep: true }), deps);
		const e = step(r, "e");
		expect(e.status).toBe("fail");
		expect(e.problem).toStartWith("provider login failed: ");
		expect(e.problem).not.toContain("; fix: ");
		expect(e.fix).toBe(PROVIDER_LOGIN_FIX);
		expect(r.ok).toBe(false);
	});

	test("an answer other than OK is a warning", async () => {
		const { deps } = world({
			run: async () => ({ status: "done", summary: "I did many things" }),
		});
		expect(step(await runDoctor(input({ deep: true }), deps), "e").status).toBe(
			"warn",
		);
	});

	test("a mode that asks for permission is a warning in step c", async () => {
		const s = settings({ agent: { provider: "claude", mode: "default" } });
		const { deps } = world();
		const c = step(await runDoctor(input({}, s), deps), "c");
		expect(c.status).toBe("warn");
		expect(c.detail.join("\n")).toContain("mode default of claude asks");
		expect(c.fix).toContain("--mode auto");
	});

	test("version mismatch warns with the update command (mm-210.77)", async () => {
		const { deps } = world({ server: "def456" });
		const a = step(await runDoctor(input(), deps), "a");
		expect(a.status).toBe("warn");
		expect(a.detail.join("\n")).toContain("is older than the server def456");
		expect(a.fix).toBe("mastermind-runner update");
	});

	test("a revoked credential fails a and skips b", async () => {
		const { deps } = world({ credential: 401 });
		const r = await runDoctor(input(), deps);
		expect(step(r, "a").status).toBe("fail");
		expect(step(r, "b").status).toBe("skip");
	});

	test("NATS: refused, slow, and no publish permission", async () => {
		const refused = world({
			connect: async () => {
				throw new Error("Authorization Violation");
			},
		});
		const b1 = step(await runDoctor(input(), refused.deps), "b");
		expect(b1.status).toBe("fail");
		expect(b1.detail[0]).toContain("NATS refused the credential");

		let t = 0;
		const slow = world();
		const b2 = step(
			await runDoctor(input(), {
				...slow.deps,
				clock: () => {
					t += 2_500;
					return t;
				},
			}),
			"b",
		);
		expect(b2.status).toBe("warn");

		const denied = world({
			connect: async (o) => ({
				getServer: () => "nats.example:443",
				publish: () =>
					o.onStatus?.({
						type: "error",
						error: new Error("Permissions Violation for Publish"),
					} as never),
				flush: async () => {},
				close: async () => {},
			}),
		});
		const b3 = step(await runDoctor(input(), denied.deps), "b");
		expect(b3.status).toBe("fail");
		expect(b3.detail.join("\n")).toContain("cannot publish");
	});

	test("an unavailable provider and a missing workdir fail step d", async () => {
		const s = settings({ workdir: "/no/such/dir-mm" });
		const { deps } = world({
			providers: [{ provider: "claude", status: "unavailable" }],
		});
		const d = step(await runDoctor(input({}, s), deps), "d");
		expect(d.status).toBe("fail");
		expect(d.detail.join("\n")).toContain("provider claude is unavailable");
		expect(d.detail.join("\n")).toContain("/no/such/dir-mm does not exist");
	});
});

test("asksPermission knows claude's asking modes", () => {
	expect(asksPermission("claude", "default")).toBe(true);
	expect(asksPermission("claude/opus", "plan")).toBe(true);
	expect(asksPermission("claude", "auto")).toBe(false);
	expect(asksPermission("codex", "default")).toBe(false);
});

test("paseoError reads Paseo's JSON error", () => {
	expect(
		paseoError({
			code: 1,
			stdout: '{"error":{"code":"DAEMON_UNREACHABLE","message":"no daemon"}}',
			stderr: "",
		}),
	).toBe("DAEMON_UNREACHABLE: no daemon");
	expect(paseoError({ code: 2, stdout: "", stderr: " a\n b " })).toBe("a b");
});

test("the command line hides secret values", () => {
	const line = paseoCommandLine({
		title: "t",
		cwd: "/w",
		agent: { provider: "claude", mode: "auto" },
		labels: { purpose: "probe" },
		envNames: ["GH_TOKEN"],
	});
	expect(line).toContain("MASTERMIND_ENV_FILE=");
	expect(line).not.toContain("GH_TOKEN");
	expect(line).not.toContain("secret");
	expect(line).toContain("--label purpose=probe");
});

describe("doctor step g: box", () => {
	const image = "ghcr.io/getpaseo/paseo:0.15.4";

	test("without a box input there is no step g", async () => {
		const r = await runDoctor(input(), world().deps);
		expect(r.steps.find((x) => x.id === "g")).toBeUndefined();
	});

	test("--no-box: SKIP with the reason", async () => {
		const g = step(
			await runDoctor(input({ box: { noBox: true } }), world().deps),
			"g",
		);
		expect(g.status).toBe("skip");
		expect(g.detail[0]).toContain("--no-box");
	});

	test("plain doctor: engine answers and the default image is there; no box is made", async () => {
		const driver = new FakeDriver();
		const g = step(
			await runDoctor(input({ box: { driver, image } }), world().deps),
			"g",
		);
		expect(g.status).toBe("pass");
		expect(g.detail.join("\n")).toContain("engine fake answers: fake 1.0");
		expect(g.detail.join("\n")).not.toContain("runtimes:");
		expect(driver.images).toEqual([{ image }]);
		expect(driver.created).toHaveLength(0);
	});

	test("runtimes: gVisor available or not installed, never a failure (mm-210.63)", async () => {
		const driver = new FakeDriver();
		driver.runtimeList = ["crun", "runc"];
		const g = step(
			await runDoctor(input({ box: { driver, image } }), world().deps),
			"g",
		);
		expect(g.status).toBe("pass");
		expect(g.detail.join("\n")).toContain(
			"runtimes: crun, runc; gVisor (runsc) not installed: environments with runtime gvisor are not ready here",
		);
		driver.runtimeList = ["runc", "runsc"];
		const g2 = step(
			await runDoctor(input({ box: { driver, image } }), world().deps),
			"g",
		);
		expect(g2.detail.join("\n")).toContain("gVisor (runsc) available");
	});

	test("engine down: FAIL with the fix, --no-box included", async () => {
		const driver = new FakeDriver();
		driver.ping = async () => {
			throw new BoxError(
				"cannot reach the box engine at unix:///x.sock: ENOENT; fix: start Docker",
			);
		};
		const r = await runDoctor(input({ box: { driver, image } }), world().deps);
		const g = step(r, "g");
		expect(g.status).toBe("fail");
		expect(g.problem).toContain("ENOENT");
		expect(g.problem).not.toContain("fix:");
		expect(g.fix).toContain("--no-box");
		expect(r.ok).toBe(false);
		expect(driver.images).toHaveLength(0);
	});

	test("image cannot be pulled: FAIL with the fix", async () => {
		const driver = new FakeDriver();
		driver.ensureImage = async () => {
			throw new BoxError("pull x: manifest unknown");
		};
		const g = step(
			await runDoctor(input({ box: { driver, image: "x" } }), world().deps),
			"g",
		);
		expect(g.status).toBe("fail");
		expect(g.problem).toContain("manifest unknown");
		expect(g.fix).toContain("--box-image");
	});

	test("--deep: makes a labelled box, waits for paseo status as paseo, deletes it", async () => {
		const driver = new FakeDriver();
		let tries = 0;
		driver.handler = (cmd) =>
			cmd[0] === "paseo" && ++tries < 3
				? { code: 1, stdout: "", stderr: "daemon not running" }
				: undefined;
		const { deps } = world();
		const r = await runDoctor(input({ deep: true, box: { driver, image } }), {
			...deps,
			sleep: async () => {},
		});
		const g = step(r, "g");
		expect(g.status).toBe("pass");
		expect(driver.created).toHaveLength(1);
		expect(driver.created[0]?.labels["mastermind.runner"]).toBe("laptop");
		const status = driver.execs.filter((e) => e.cmd[0] === "paseo");
		expect(status).toHaveLength(3);
		expect(status[0]?.cmd).toEqual(["paseo", "status", "--json"]);
		expect(status[0]?.opts.user).toBe("paseo");
		expect(driver.boxes.size).toBe(0);
		expect(g.detail.join("\n")).toMatch(/made in \d+ ms/);
		expect(g.detail.join("\n")).toMatch(/deleted in \d+ ms/);
	});

	test("--deep: the agent host never answers: FAIL, and the box is still deleted", async () => {
		const driver = new FakeDriver();
		driver.handler = (cmd) =>
			cmd[0] === "paseo"
				? { code: 1, stdout: "", stderr: "connect ECONNREFUSED" }
				: undefined;
		let t = 0;
		const { deps } = world();
		const g = step(
			await runDoctor(
				input({ deep: true, box: { driver, image }, boxReadyTimeoutMs: 1_000 }),
				{ ...deps, clock: () => (t += 400), sleep: async () => {} },
			),
			"g",
		);
		expect(g.status).toBe("fail");
		expect(g.problem).toContain("ECONNREFUSED");
		expect(g.problem).toContain("daemon log");
		expect(driver.boxes.size).toBe(0);
		expect(driver.removed).toHaveLength(1);
	});

	test("--deep: a box that cannot be made: FAIL, nothing left", async () => {
		const driver = new FakeDriver();
		driver.createError = new BoxError("POST /containers/create: 500 no space");
		const g = step(
			await runDoctor(
				input({ deep: true, box: { driver, image } }),
				world().deps,
			),
			"g",
		);
		expect(g.status).toBe("fail");
		expect(g.problem).toContain("no space");
		expect(driver.boxes.size).toBe(0);
	});
});

describe("doctor step h: model credential (mm-210.80)", () => {
	/** The world's fakes, but /v1/models goes to a fake Anthropic over HTTP. */
	const withAnthropic = (deps: DoctorDeps): DoctorDeps => {
		const base = deps.fetch as typeof fetch;
		return {
			...deps,
			fetch: ((u: string, init?: RequestInit) =>
				String(u).includes("/v1/models")
					? fetch(u, init)
					: base(u, init)) as typeof fetch,
		};
	};
	const run = async (value: string | null) => {
		const api = fakeAnthropic();
		try {
			const r = await runDoctor(
				input({
					modelUpstream: api.url,
					model: async () =>
						value === null
							? null
							: { secret: "CLAUDE_CODE_OAUTH_TOKEN", value, from: "store" },
				}),
				withAnthropic(world().deps),
			);
			return { r, h: step(r, "h"), seen: api.seen };
		} finally {
			api.stop();
		}
	};

	test("a wrong stored token: FAIL with the setup-token fix; the value is never in the report", async () => {
		const { r, h, seen } = await run("sk-ant-oat01-wrong");
		expect(h.status).toBe("fail");
		expect(h.problem).toBe(
			"CLAUDE_CODE_OAUTH_TOKEN (store) at Anthropic: refused (401) (GET /v1/models with the box proxy's header)",
		);
		expect(h.fix).toBe(
			"run claude setup-token again, then mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN",
		);
		expect(r.ok).toBe(false);
		expect(seen[0]?.get("authorization")).toBe("Bearer sk-ant-oat01-wrong");
		const text = `${JSON.stringify(r)}\n${formatReport(r).join("\n")}`;
		expect(text).not.toContain("sk-ant-oat01-wrong");
		expect(text).toContain("FAIL h. model credential");
	});

	test("a valid token: PASS", async () => {
		const { r, h } = await run(GOOD_TOKEN);
		expect(h.status).toBe("pass");
		expect(h.detail[0]).toContain("at Anthropic: accepted");
		expect(r.ok).toBe(true);
	});

	test("no model credential on this machine: PASS with a note (step f owns missing secrets)", async () => {
		const { h } = await run(null);
		expect(h.status).toBe("pass");
		expect(h.detail[0]).toContain("no CLAUDE_CODE_OAUTH_TOKEN");
	});

	test("Anthropic does not answer: WARN, not FAIL", async () => {
		const r = await runDoctor(
			input({
				modelUpstream: "http://127.0.0.1:1",
				model: async () => ({
					secret: "CLAUDE_CODE_OAUTH_TOKEN",
					value: "t",
					from: "env:CLAUDE_CODE_OAUTH_TOKEN",
				}),
			}),
			withAnthropic(world().deps),
		);
		expect(step(r, "h").status).toBe("warn");
		expect(step(r, "h").problem).toContain("not checked (network)");
	});
});
