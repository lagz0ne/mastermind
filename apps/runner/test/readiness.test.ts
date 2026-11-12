import { afterEach, describe, expect, test } from "bun:test";
import type { DirectOffer, RunnerReadiness } from "@mastermind/core";
import type { CheckResult } from "../src/check.ts";
import { defaultSettings, type RunnerSettings } from "../src/config.ts";
import type { Checks } from "../src/diagnostics.ts";
import { fail, pass, runOnboard } from "../src/onboard.ts";
import {
	evaluate,
	gateReason,
	type ReadinessFacts,
	readinessLine,
} from "../src/readiness.ts";
import { Runner } from "../src/runner.ts";
import type { SecretsState } from "../src/secrets/state.ts";
import { dispatch, FakeLauncher, FakeMastermind, until } from "./fakes.ts";

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	...defaultSettings("laptop"),
	queues: ["q"],
	workdir: "/tmp",
	agent: { provider: "claude" },
	...over,
});

const checks = (over: Partial<Checks> = {}): Checks => ({
	paseo: true,
	providers: { claude: true },
	workdir: true,
	checkedAt: "2026-11-12T00:00:00Z",
	...over,
});

/** Environments web (needs GH_TOKEN) and api (needs API_KEY, missing). */
const secrets = (missing: string[] = ["API_KEY"]): SecretsState => {
	const rows = [
		{
			name: "GH_TOKEN",
			neededBy: ["web"],
			present: !missing.includes("GH_TOKEN"),
			from: null,
		},
		{
			name: "API_KEY",
			neededBy: ["api"],
			present: !missing.includes("API_KEY"),
			from: null,
		},
	];
	return {
		rows,
		needs: {
			at: "2026-11-12T00:00:00Z",
			environments: [
				{ name: "web", secrets: ["GH_TOKEN"] },
				{ name: "api", secrets: ["API_KEY"] },
				{ name: "plain", secrets: [] },
			],
		},
		diagnostics: {
			needed: ["API_KEY", "GH_TOKEN"],
			missing,
			needsAt: "2026-11-12T00:00:00Z",
		},
	};
};

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
	onboarded: true,
	checks: checks(),
	box: { ok: true },
	secrets: secrets(),
	settings: settings(),
	routing: { environments: {}, implicit: true },
	...over,
});

describe("evaluate", () => {
	test("auto-update draining: degraded, no environment ready (mm-210.77)", () => {
		const r = evaluate(
			facts({ secrets: secrets([]), updating: "updating to ce20fc6" }),
		);
		expect(r.state).toBe("degraded");
		expect(r.readyEnvironments).toEqual([]);
		expect(r.failedChecks[0]).toMatchObject({
			check: "update",
			problem: "updating to ce20fc6",
		});
		expect(evaluate(facts({ secrets: secrets([]) })).state).toBe("ready");
	});
	test("not onboarded: onboarding, nothing ready", () => {
		const r = evaluate(facts({ onboarded: false }));
		expect(r.state).toBe("onboarding");
		expect(r.readyEnvironments).toEqual([]);
		expect(r.failedChecks[0]?.fix).toBe("mastermind-runner onboard");
	});

	test("checks not run yet: checking", () => {
		expect(evaluate(facts({ box: undefined })).state).toBe("checking");
		expect(evaluate(facts({ secrets: undefined })).state).toBe("checking");
		expect(evaluate(facts({ checks: checks({ checkedAt: null }) })).state).toBe(
			"checking",
		);
	});

	test("all pass: ready for environments whose secrets are present", () => {
		const r = evaluate(facts());
		expect(r.state).toBe("ready");
		expect(r.readyEnvironments).toEqual(["web", "plain"]);
		expect(r.failedChecks).toEqual([
			{
				check: "secrets",
				environment: "api",
				problem: "missing secrets: API_KEY",
				fix: "mastermind-runner secrets set API_KEY",
			},
		]);
	});

	test("a secret removed: that environment drops out, the others stay", () => {
		const r = evaluate(facts({ secrets: secrets(["GH_TOKEN", "API_KEY"]) }));
		expect(r.state).toBe("ready");
		expect(r.readyEnvironments).toEqual(["plain"]);
	});

	test("bound environments: only those count", () => {
		const r = evaluate(
			facts({
				routing: { environments: { web: {} as never }, implicit: false },
			}),
		);
		expect(r.readyEnvironments).toEqual(["web"]);
	});

	test("repo not readable: that environment drops out with the reason", () => {
		const r = evaluate(
			facts({
				access: {
					web: {
						ok: false,
						repo: "https://github.com/x/web.git",
						ref: "main",
						problem: "no access to https://github.com/x/web.git with GH_TOKEN",
						fix: "give the credential read access",
					},
					plain: { ok: true, repo: "https://github.com/x/p.git", ref: "" },
				},
			}),
		);
		expect(r.state).toBe("ready");
		expect(r.readyEnvironments).toEqual(["plain"]);
		expect(r.failedChecks).toContainEqual({
			check: "git",
			environment: "web",
			problem: "no access to https://github.com/x/web.git with GH_TOKEN",
			fix: "give the credential read access",
		});
		expect(gateReason(r, "web")).toContain("no access to");
		expect(gateReason(r, "plain")).toBeNull();
	});

	test("engine gone or Paseo down: degraded, no environment ready", () => {
		const engine = evaluate(
			facts({
				box: { ok: false, problem: "box engine: no Docker", fix: "start it" },
			}),
		);
		expect(engine.state).toBe("degraded");
		expect(engine.readyEnvironments).toEqual([]);
		expect(engine.failedChecks[0]).toEqual({
			check: "engine",
			problem: "box engine: no Docker",
			fix: "start it",
		});
		const paseo = evaluate(facts({ checks: checks({ paseo: false }) }));
		expect(paseo.state).toBe("degraded");
		expect(paseo.failedChecks.map((c) => c.check)).toContain("paseo");
		expect(readinessLine(paseo)).toContain("readiness: degraded");
	});

	test("environments unknown: runner-wide failure", () => {
		const r = evaluate(
			facts({
				secrets: {
					rows: [],
					needs: null,
					problem: "Mastermind does not answer",
					diagnostics: { needed: [], missing: [], needsAt: null },
				},
			}),
		);
		expect(r.state).toBe("degraded");
	});

	test("--no-box: no engine check", () => {
		expect(evaluate(facts({ box: null })).state).toBe("ready");
	});

	describe("runtime gvisor (mm-210.63)", () => {
		const withStrong = (): SecretsState => {
			const s = secrets([]);
			s.needs?.environments.push({
				name: "strong",
				secrets: [],
				runtime: "gvisor",
			});
			return s;
		};
		test("engine without runsc: only that environment is not ready, with the reason and a fix", () => {
			const r = evaluate(
				facts({
					secrets: withStrong(),
					box: { ok: true, runtimes: ["crun", "runc"] },
				}),
			);
			expect(r.state).toBe("ready");
			expect(r.readyEnvironments).toEqual(["web", "api", "plain"]);
			const c = r.failedChecks.find((x) => x.environment === "strong");
			expect(c?.check).toBe("runtime");
			expect(c?.problem).toBe(
				"runtime gvisor: the box engine has no runsc runtime (has: crun, runc)",
			);
			expect(c?.fix).toContain("gvisor.dev");
			expect(gateReason(r, "strong")).toContain(
				"environment strong is not ready here: runtime gvisor",
			);
		});
		test("engine with runsc: ready", () => {
			const r = evaluate(
				facts({
					secrets: withStrong(),
					box: { ok: true, runtimes: ["runc", "runsc"] },
				}),
			);
			expect(r.readyEnvironments).toContain("strong");
			expect(r.failedChecks).toEqual([]);
		});
		test("runtimes unknown or --no-box: not ready for it", () => {
			const unknown = evaluate(facts({ secrets: withStrong() }));
			expect(unknown.readyEnvironments).not.toContain("strong");
			const noBox = evaluate(facts({ secrets: withStrong(), box: null }));
			expect(
				noBox.failedChecks.find((x) => x.environment === "strong")?.problem,
			).toContain("--no-box");
		});
	});
});

describe("gateReason", () => {
	const ready = evaluate(facts());
	test("ready: env-less and ready environments pass", () => {
		expect(gateReason(ready, undefined)).toBeNull();
		expect(gateReason(ready, "web")).toBeNull();
		expect(gateReason(ready, "api")).toBe(
			"environment api is not ready here: missing secrets: API_KEY",
		);
	});
	test("not ready: refused with the state", () => {
		expect(gateReason(evaluate(facts({ onboarded: false })), "web")).toContain(
			"not ready (onboarding",
		);
	});
});

describe("Runner gate", () => {
	let runner: Runner | undefined;
	afterEach(async () => {
		await runner?.stop();
		runner = undefined;
	});
	const okCheck = async (): Promise<CheckResult> => ({
		ok: true,
		cwd: "/work",
		env: {},
	});

	test("asks next only when ready; readinessChanged wakes it", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-1"));
		const launcher = new FakeLauncher({ status: "done", summary: "ok" });
		let readiness: RunnerReadiness = evaluate(facts({ onboarded: false }));
		runner = new Runner({
			client: mm,
			launcher,
			settings: settings(),
			check: okCheck,
			idleMs: 10,
			heartbeatMs: 20,
			readiness: () => readiness,
		});
		runner.start();
		await Bun.sleep(50);
		expect(mm.nextCalls).toBe(0);
		readiness = evaluate(facts());
		runner.readinessChanged();
		await until(() => mm.verbs("complete").length === 1);
	});

	test("an offer for an environment that is not ready is declined", () => {
		const ready = evaluate(facts());
		runner = new Runner({
			client: new FakeMastermind(),
			launcher: new FakeLauncher(),
			settings: settings(),
			check: okCheck,
			readiness: () => ready,
		});
		const offer = (env: string): DirectOffer => {
			const d = dispatch("mm-2");
			return {
				bead: d.bead,
				queue: "to:alice",
				stage: "work",
				env: { ...d.env, name: env },
				prompt: d.prompt,
				address: "alice",
			};
		};
		expect(runner.consider(offer("api"))).toEqual({
			accept: false,
			reason: "environment api is not ready here: missing secrets: API_KEY",
		});
		expect(runner.consider(offer("web")).accept).toBe(true);
		runner.dropOffer();
	});
});

describe("runOnboard", () => {
	test("stops at the first FAIL with the fix; later steps do not run", async () => {
		const out: string[] = [];
		const ran: string[] = [];
		const ok = await runOnboard(
			[
				{
					name: "box engine",
					run: async () => {
						ran.push("engine");
						return fail("no Docker", "install Docker");
					},
				},
				{
					name: "enroll",
					run: async () => {
						ran.push("enroll");
						return pass();
					},
				},
			],
			(l) => out.push(l),
		);
		expect(ok).toBe(false);
		expect(ran).toEqual(["engine"]);
		expect(out[0]).toBe("✗ 1/2 box engine: no Docker");
		expect(out[1]).toBe("  fix: install Docker");
		expect(out[2]).toContain("NOT READY");
	});

	test("a step that throws fails; all passing returns true", async () => {
		const out: string[] = [];
		expect(
			await runOnboard(
				[
					{
						name: "x",
						run: async () => {
							throw new Error("boom");
						},
					},
				],
				(l) => out.push(l),
			),
		).toBe(false);
		expect(out[0]).toBe("✗ 1/1 x: boom");
		expect(
			await runOnboard([{ name: "y", run: async () => pass("fine") }], (l) =>
				out.push(l),
			),
		).toBe(true);
		expect(out.at(-1)).toBe("✓ 1/1 y: fine");
	});
});
