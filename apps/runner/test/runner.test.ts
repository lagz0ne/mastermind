import { afterEach, describe, expect, test } from "bun:test";
import { NO_BOX_REPORT } from "../src/box/run.ts";
import type { CheckResult } from "../src/check.ts";
import { defaultSettings, type RunnerSettings } from "../src/config.ts";
import type { AgentLauncher } from "../src/launcher.ts";
import { PaseoLauncher } from "../src/launcher.ts";
import { parseRouting, type Routing } from "../src/routing.ts";
import {
	agentPrompt,
	executionId,
	MAX_PROGRESS,
	Runner,
	scrub,
} from "../src/runner.ts";
import { dispatch, FakeLauncher, FakeMastermind, until } from "./fakes.ts";
import { FakePaseo } from "./paseo/fake.ts";

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	...defaultSettings("laptop"),
	queues: ["q"],
	workdir: "/tmp",
	agent: { provider: "claude" },
	...over,
});
const pass = async (): Promise<CheckResult> => ({
	ok: true,
	cwd: "/work",
	env: {},
});

let runner: Runner | undefined;
afterEach(async () => {
	await runner?.stop();
	runner = undefined;
});

function make(
	mm: FakeMastermind,
	launcher: FakeLauncher,
	over: Partial<RunnerSettings> = {},
	check = pass,
	routing?: Routing,
) {
	runner = new Runner({
		client: mm,
		launcher,
		settings: settings(over),
		check,
		...(routing ? { routing } : {}),
		idleMs: 10,
		heartbeatMs: 20,
		backoff: { minMs: 5, maxMs: 20 },
	});
	runner.start();
	return runner;
}

describe("Runner", () => {
	test("no --provider configured: paseo run still gets one (mm-210.46)", async () => {
		const fake = new FakePaseo();
		try {
			const mm = new FakeMastermind();
			mm.push(dispatch("mm-1"));
			runner = new Runner({
				client: mm,
				launcher: new PaseoLauncher({ connect: fake.connect }),
				settings: settings({ agent: {}, providers: ["codex", "claude"] }),
				check: pass,
				providerStatus: () => ({ codex: false, claude: true }),
				idleMs: 10,
				heartbeatMs: 20,
				backoff: { minMs: 5, maxMs: 20 },
			});
			runner.start();
			await until(() => mm.verbs("complete").length === 1, 10_000);
			expect(mm.verbs("report")[0]?.text).toBe(
				"target default on local, provider claude, mode auto (runner laptop, rule 1)",
			);
			expect(fake.agents[0]?.provider).toBe("claude");
			expect(fake.agents[0]?.modeId).toBe("auto");
			expect(mm.verbs("release")).toEqual([]);
		} finally {
			await runner?.stop();
			runner = undefined;
		}
	});

	test("done: completes the bead with the agent's summary", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "fixed it" });
		mm.push(dispatch("mm-1"));
		make(mm, agents);
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.verbs("complete")[0]).toEqual({
			verb: "complete",
			bead: "mm-1",
			actor: "alice/laptop",
			text: "fixed it",
		});
		expect(mm.verbs("report")[0]?.text).toBe(
			"target default on local, provider claude, mode auto (runner laptop, rule 1)",
		);
		const spec = agents.specs[0];
		expect(spec?.cwd).toBe("/work");
		expect(spec?.prompt).toContain("do mm-1");
		expect(spec?.prompt).toContain('status "done"');
		expect(spec?.executionId).toStartWith("mm-1-");
	});

	test("done with box output: complete carries the branch and the PR", async () => {
		const mm = new FakeMastermind();
		const output = {
			branch: "mm/mm-1",
			prUrl: "https://github.com/o/r/pull/3",
			commits: 1,
			filesChanged: 2,
		};
		mm.push(dispatch("mm-1"));
		make(mm, new FakeLauncher({ status: "done", summary: "ok", output }));
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.verbs("complete")[0]?.output).toEqual(output);
	});

	test("the launcher gets the dispatch's environment as the box recipe", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "ok" });
		const d = dispatch("mm-1");
		mm.push(d);
		make(mm, agents);
		await until(() => mm.verbs("complete").length === 1);
		expect(agents.specs[0]?.recipe).toEqual(d.env);
		expect(mm.verbs("report").map((c) => c.text)).not.toContain(NO_BOX_REPORT);
	});

	test("--no-box: every task first reports that it ran without a box", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-1"));
		runner = new Runner({
			client: mm,
			launcher: new FakeLauncher({ status: "done", summary: "ok" }),
			settings: settings(),
			check: pass,
			noBox: true,
			idleMs: 10,
			heartbeatMs: 20,
		});
		runner.start();
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.verbs("report")[0]?.text).toBe(NO_BOX_REPORT);
		expect(NO_BOX_REPORT).toBe("ran WITHOUT a box (owner's risk)");
	});

	test("box progress lines reach the ticket in order, before the result, without secret values (mm-210.57)", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-1"));
		const steps: AgentLauncher = {
			async run(spec) {
				runner?.progress(spec.beadId, "box mm-box-1 ready in 1.2 s");
				runner?.progress(
					spec.beadId,
					"checked out https://x:tok@github.com/o/r at main (abc)",
				);
				runner?.progress(spec.beadId, "setup printed s3cr3t-value");
				runner?.progress(spec.beadId, "commits by mm-app[bot] (app 4242)");
				runner?.progress("mm-other", "not this bead");
				runner?.progress(spec.beadId, "box mm-box-1 deleted");
				return { status: "done", summary: "used s3cr3t-value" };
			},
		};
		runner = new Runner({
			client: mm,
			launcher: steps,
			settings: settings(),
			check: async () => ({
				ok: true,
				cwd: "/work",
				// The app id and slug are public: not redacted (mm-210.87).
				env: {
					TOKEN: "s3cr3t-value",
					GITHUB_APP_ID: "4242",
					GITHUB_APP_SLUG: "mm-app",
				},
			}),
			idleMs: 10,
			heartbeatMs: 20,
		});
		runner.start();
		await until(() => mm.verbs("complete").length === 1);
		const verbs = mm.calls.map((c) => c.verb);
		expect(verbs.lastIndexOf("report")).toBeLessThan(verbs.indexOf("complete"));
		expect(mm.verbs("report").map((c) => c.text)).toEqual([
			"target default on local, provider claude, mode auto (runner laptop, rule 1)",
			"box mm-box-1 ready in 1.2 s",
			"checked out https://***@github.com/o/r at main (abc)",
			"setup printed ***",
			"commits by mm-app[bot] (app 4242)",
			"box mm-box-1 deleted",
		]);
		expect(mm.verbs("complete")[0]?.text).toBe("used ***");
	});

	test("progress lines are capped per execution", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-1"));
		const logs: string[] = [];
		runner = new Runner({
			client: mm,
			launcher: {
				async run(spec) {
					for (let i = 0; i < MAX_PROGRESS + 5; i++)
						runner?.progress(spec.beadId, `line ${i}`);
					return { status: "done", summary: "ok" };
				},
			},
			settings: settings(),
			check: pass,
			log: (l) => logs.push(l),
			idleMs: 10,
			heartbeatMs: 20,
		});
		runner.start();
		await until(() => mm.verbs("complete").length === 1);
		// The routing line plus MAX_PROGRESS lines.
		expect(mm.verbs("report")).toHaveLength(MAX_PROGRESS + 1);
		expect(
			logs.filter((l) => l.includes("progress lines go only")),
		).toHaveLength(1);
	});

	test("scrub: secret values and URL credentials", () => {
		expect(scrub("git@x and ssh://u:p@h/r", ["abc"])).toBe(
			"git@x and ssh://***@h/r",
		);
		expect(scrub("a abcdef b abcd", ["abcd", "abcdef"])).toBe("a *** b ***");
		expect(scrub("short ab", ["ab"])).toBe("short ab");
	});

	test("failed: releases the bead with the agent's reason", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-2"));
		make(mm, new FakeLauncher({ status: "failed", summary: "tests are red" }));
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toBe("tests are red");
		// The agent ran: not a failed start.
		expect(mm.verbs("release")[0]?.startFailed).toBeUndefined();
		expect(mm.verbs("complete")).toHaveLength(0);
	});

	test("done but not delivered: release asks Mastermind to hold the item (mm-2oj)", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-2"));
		make(
			mm,
			new FakeLauncher({
				status: "failed",
				summary: "output failed after 3 tries: push refused.",
				hold: true,
			}),
		);
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.hold).toBe(true);
		expect(mm.verbs("release")[0]?.startFailed).toBeUndefined();
	});

	test("an agent failure does not ask for a hold", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-2"));
		make(mm, new FakeLauncher({ status: "failed", summary: "tests are red" }));
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.hold).toBeUndefined();
	});

	test("a failed check releases without starting an agent", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "x" });
		mm.push(dispatch("mm-3"));
		make(mm, agents, {}, async () => ({
			ok: false,
			reason: "git: not on PATH",
		}));
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toBe("git: not on PATH");
		expect(mm.verbs("release")[0]?.startFailed).toBe(true);
		expect(agents.specs).toHaveLength(0);
	});

	test("never runs more agents than capacity", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		for (const id of ["a", "b", "c"]) mm.push(dispatch(id));
		make(mm, agents, { capacity: 2 });
		await until(() => agents.specs.length === 2);
		await Bun.sleep(50);
		expect(agents.specs).toHaveLength(2);
		agents.finish("a", { status: "done", summary: "ok" });
		await until(() => agents.specs.length === 3);
		expect(agents.maxActive).toBe(2);
	});

	test("unlimited capacity (null) runs every dispatch at once", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		for (const id of ["a", "b", "c", "d", "e"]) mm.push(dispatch(id));
		make(mm, agents, { capacity: null });
		await until(() => agents.specs.length === 5);
		expect(agents.maxActive).toBe(5);
	});

	test("capacity is shared by all queues", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("a", { queue: "q" }));
		mm.push(dispatch("b", { queue: "r" }));
		make(mm, agents, { queues: ["q", "r"], capacity: 1 });
		await until(() => agents.specs.length === 1);
		await Bun.sleep(50);
		expect(agents.specs).toHaveLength(1);
		agents.finish(agents.specs[0]?.beadId as string, {
			status: "done",
			summary: "ok",
		});
		await until(() => agents.specs.length === 2);
	});

	test("heartbeats while the agent runs; a lost claim stops the agent", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("mm-4"));
		make(mm, agents);
		await until(() => mm.verbs("heartbeat").length >= 2);
		mm.lost.add("mm-4");
		await until(() => agents.aborted.includes("mm-4"));
		await Bun.sleep(30);
		expect(mm.verbs("complete")).toHaveLength(0);
		expect(mm.verbs("release")).toHaveLength(0);
		expect(runner?.running()).toEqual([]);
	});

	test("stop stops running agents and gives their beads back", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(dispatch("mm-5"));
		const r = make(mm, agents);
		await until(() => agents.specs.length === 1);
		await r.stop();
		expect(agents.aborted).toEqual(["mm-5"]);
		expect(mm.verbs("release")[0]?.text).toBe("runner stopped");
	});

	test("a ready notice wakes an idle poller at once", async () => {
		const mm = new FakeMastermind();
		mm.waitMs = 0;
		const agents = new FakeLauncher({ status: "done", summary: "ok" });
		runner = new Runner({
			client: mm,
			launcher: agents,
			settings: settings(),
			check: pass,
			idleMs: 60_000,
		});
		runner.start();
		await until(() => mm.nextCalls === 1);
		mm.push(dispatch("mm-6"));
		mm.ready("q");
		await until(() => mm.verbs("complete").length === 1, 1000);
	});

	test("next errors back off and recover", async () => {
		const mm = new FakeMastermind();
		mm.failNext = 3;
		mm.push(dispatch("mm-7"));
		make(mm, new FakeLauncher({ status: "done", summary: "ok" }));
		await until(() => mm.verbs("complete").length === 1);
		expect(mm.nextCalls).toBeGreaterThanOrEqual(4);
	});

	test("an agent that throws is reported as failed", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-8"));
		const agents = new FakeLauncher();
		agents.run = async () => {
			throw new Error("paseo run exited 2: daemon is not running");
		};
		make(mm, agents);
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toContain("daemon is not running");
		expect(mm.verbs("release")[0]?.startFailed).toBe(true);
	});
});

describe("Runner with routing", () => {
	const routing = () =>
		parseRouting({
			targets: {
				gpu: {
					paseoHost: "gpu-box:6767",
					provider: "codex",
					labels: { pool: "gpu" },
					capacity: 1,
				},
			},
			environments: { ml: { dir: "/tmp" } },
			rules: [{ match: { env: "ml" }, target: "gpu" }],
		});
	const ml = (id: string) =>
		dispatch(id, {
			env: { name: "ml", repo: "", ref: "main", requires: [] },
		});

	test("the routed target, labels and secrets reach the launcher; the first report names the target", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "ok" });
		mm.push(ml("mm-r1"));
		const check = async (): Promise<CheckResult> => ({
			ok: true,
			cwd: "/tmp",
			env: { HF_TOKEN: "t" },
		});
		make(mm, agents, { providers: ["claude", "codex"] }, check, routing());
		await until(() => mm.verbs("complete").length === 1);
		expect(agents.specs[0]).toMatchObject({
			host: "gpu-box:6767",
			labels: { pool: "gpu" },
			env: { HF_TOKEN: "t" },
			agent: { provider: "codex" },
		});
		expect(mm.verbs("report")[0]?.text).toBe(
			"target gpu on gpu-box:6767, provider codex (runner laptop, rule 1)",
		);
	});

	test("an unbound environment is released with the reason, no agent starts", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher({ status: "done", summary: "ok" });
		mm.push(
			dispatch("mm-r2", {
				env: { name: "web", repo: "", ref: "main", requires: [] },
			}),
		);
		make(mm, agents, {}, pass, routing());
		await until(() => mm.verbs("release").length === 1);
		expect(mm.verbs("release")[0]?.text).toBe(
			"environment web is not bound on this runner",
		);
		// A decline is not a failed start (another runner may take it).
		expect(mm.verbs("release")[0]?.startFailed).toBeUndefined();
		expect(agents.specs).toHaveLength(0);
	});

	test("a target's capacity holds the second agent until the first ends", async () => {
		const mm = new FakeMastermind();
		const agents = new FakeLauncher();
		mm.push(ml("a"));
		mm.push(ml("b"));
		make(mm, agents, { capacity: 3 }, pass, routing());
		await until(() => agents.specs.length === 1);
		// b waits for the target, with its lease kept alive (heartbeats >= 200 ms apart).
		await until(() => mm.verbs("heartbeat").some((c) => c.bead === "b"));
		expect(agents.specs).toHaveLength(1);
		expect(mm.verbs("heartbeat").some((c) => c.bead === "b")).toBe(true);
		agents.finish("a", { status: "done", summary: "ok" });
		await until(() => agents.specs.length === 2);
		expect(agents.maxActive).toBe(1);
	});
});

test("executionId is stable per claim and differs between claims", () => {
	const a = dispatch("mm-1.2");
	expect(executionId(a)).toBe(executionId({ ...a }));
	const b = { ...a, lease: { ...a.lease, expiresAt: "2030-01-01T00:00:00Z" } };
	expect(executionId(b)).not.toBe(executionId(a));
	expect(agentPrompt(a)).toContain("bead mm-1.2, queue q, stage work");
});

describe("login gate hook (mm-210.81)", () => {
	const loginLine =
		'provider login failed: the agent\'s provider answered "Failed to authenticate" (Failed to authenticate. API Error: 401 OAuth access token is invalid.)';
	const run = async (launcher: AgentLauncher) => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-1"));
		const seen: { text: string; env: Record<string, string> }[] = [];
		runner = new Runner({
			client: mm,
			launcher,
			settings: settings(),
			check: async () => ({
				ok: true,
				cwd: "/work",
				env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-v" },
			}),
			onAgentFailure: (text, env) => seen.push({ text, env }),
			idleMs: 10,
			heartbeatMs: 20,
		});
		runner.start();
		await until(
			() => mm.verbs("release").length + mm.verbs("complete").length === 1,
		);
		return { mm, seen };
	};

	test("a failed agent: the hook gets its text and the secrets it had; the ticket gets no value", async () => {
		const { mm, seen } = await run({
			run: async () => {
				throw new Error(loginLine);
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.text).toContain("Failed to authenticate");
		expect(seen[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-v" });
		expect(JSON.stringify(mm.calls)).not.toContain("sk-ant-oat01-v");
	});

	test("a finished agent: no hook call", async () => {
		const { seen } = await run(
			new FakeLauncher({ status: "done", summary: "ok" }),
		);
		expect(seen).toEqual([]);
	});
});
