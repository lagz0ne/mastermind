import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
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
import { type AgentSpec, LaunchError } from "../src/launcher.ts";
import { implicitRouting } from "../src/routing.ts";

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

	test("version mismatch warns with the install command", async () => {
		const { deps } = world({ server: "def456" });
		const a = step(await runDoctor(input(), deps), "a");
		expect(a.status).toBe("warn");
		expect(a.fix).toBe(
			"update the runner: curl -fsSL https://mm.example/install.sh | sh",
		);
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
	expect(line).toContain("GH_TOKEN=…");
	expect(line).not.toContain("secret");
	expect(line).toContain("--label purpose=probe");
});
