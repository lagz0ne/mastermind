import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paseoRunAgent } from "../../src/box/launcher.ts";
import {
	type AgentClient,
	providerModel,
	readResult,
	runAgentOverPaseo,
	structuredPrompt,
} from "../../src/box/paseo-control.ts";
import { type BoxClient, linkDriver } from "../../src/box/paseo-link.ts";
import { type BoxTask, runInBox } from "../../src/box/run.ts";
import { FakeDriver } from "./fake-driver.ts";

const out = mkdtempSync(join(tmpdir(), "mm-pc-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const never = new AbortController().signal;

function task(over: Partial<BoxTask> = {}): BoxTask {
	return {
		executionId: "mm-1-1",
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
			tools: [],
			recipeHash: "h1",
			setup: [],
			check: [],
			limits: { cpu: 2, memoryMb: 2048, timeoutMin: 60 },
			network: "open",
		},
		agent: { provider: "claude" },
		secrets: {},
		...over,
	};
}

type Finish = Awaited<ReturnType<AgentClient["waitForFinish"]>>;
const idle = (lastMessage: string | null): Finish => ({
	status: "idle",
	final: null,
	error: null,
	lastMessage,
});

/** A fake SDK client: answers in order from `finishes`. */
function fakeClient(finishes: (Finish | Error)[], timeline: string[] = []) {
	const calls: { op: string; arg?: unknown }[] = [];
	const c = {
		createWorkspace: async (arg: unknown) => {
			calls.push({ op: "createWorkspace", arg });
			return {
				workspace: { id: "ws-1", workspaceDirectory: "/workspace" },
				error: null,
			};
		},
		createAgent: async (arg: unknown) => {
			calls.push({ op: "createAgent", arg });
			return { id: "ag-1" };
		},
		waitForFinish: async () => {
			calls.push({ op: "waitForFinish" });
			const f = finishes.shift();
			if (!f) return new Promise<Finish>(() => {});
			if (f instanceof Error) throw f;
			return f;
		},
		sendMessage: async (_id: string, text: string) => {
			calls.push({ op: "sendMessage", arg: text });
			return {};
		},
		fetchAgentTimeline: async () => ({
			entries: timeline.map((text) => ({
				item: { type: "assistant_message", text },
			})),
		}),
		cancelAgent: async (id: string) => {
			calls.push({ op: "cancelAgent", arg: id });
		},
		fetchAgents: async () => ({}),
		close: async () => {
			calls.push({ op: "close" });
		},
	};
	return { c: c as unknown as BoxClient, calls };
}

describe("providerModel", () => {
	test("provider/model is split; --model wins", () => {
		expect(providerModel(task({ agent: { provider: "claude/opus" } }))).toEqual(
			{ provider: "claude", model: "opus" },
		);
		expect(
			providerModel(task({ agent: { provider: "codex", model: "gpt-5.4" } })),
		).toEqual({ provider: "codex", model: "gpt-5.4" });
		expect(providerModel(task({ agent: {} })).provider).toBe("claude");
	});
});

describe("readResult", () => {
	test("plain, fenced and embedded JSON; errors otherwise", () => {
		const v = { status: "done" as const, summary: "ok" };
		expect(readResult(JSON.stringify(v))).toEqual({ ok: true, value: v });
		expect(
			readResult(`here:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``),
		).toEqual({ ok: true, value: v });
		expect(readResult(`Result: ${JSON.stringify(v)} bye`)).toEqual({
			ok: true,
			value: v,
		});
		const bad = readResult('{"status":"maybe"}');
		expect(bad.ok).toBe(false);
		expect(readResult("no json").ok).toBe(false);
	});
});

describe("runAgentOverPaseo", () => {
	test("workspace at /workspace, agent with schema, labels and mode; the result as stdout", async () => {
		const { c, calls } = fakeClient([
			idle('{"status":"done","summary":"fixed"}'),
		]);
		const r = await runAgentOverPaseo(
			c,
			task({ labels: { team: "a" } }),
			never,
		);
		expect(r).toEqual({
			code: 0,
			stdout: '{"status":"done","summary":"fixed"}',
			stderr: "",
		});
		expect(calls[0]).toEqual({
			op: "createWorkspace",
			arg: { source: { kind: "directory", path: "/workspace" } },
		});
		const create = calls[1]?.arg as Record<string, unknown>;
		expect(create).toMatchObject({
			provider: "claude",
			modeId: "bypassPermissions",
			cwd: "/workspace",
			workspaceId: "ws-1",
			title: "mm-1: fix it",
			initialPrompt: structuredPrompt("fix the bug"),
			labels: {
				team: "a",
				"mastermind.execution": "mm-1-1",
				"mastermind.bead": "mm-1",
			},
		});
		expect(create.outputSchema).toBeDefined();
	});

	test("a wrong answer is retried with the errors, at most 2 times", async () => {
		const { c, calls } = fakeClient([
			idle("I fixed it"),
			idle('{"status":"done","summary":"fixed"}'),
		]);
		const r = await runAgentOverPaseo(c, task(), never);
		expect(r.code).toBe(0);
		const retry = calls.find((x) => x.op === "sendMessage")?.arg as string;
		expect(retry).toContain("Previous response was invalid");

		const bad = fakeClient([idle("x"), idle("y"), idle("z")]);
		const r2 = await runAgentOverPaseo(bad.c, task(), never);
		expect(r2.code).toBe(1);
		expect(r2.stderr).toContain("does not match the result schema");
		expect(bad.calls.filter((x) => x.op === "sendMessage")).toHaveLength(2);
	});

	test("no last message: the timeline's last assistant message", async () => {
		const { c } = fakeClient(
			[idle(null)],
			['{"status":"failed","summary":"cannot"}'],
		);
		const r = await runAgentOverPaseo(c, task(), never);
		expect(JSON.parse(r.stdout)).toEqual({
			status: "failed",
			summary: "cannot",
		});
	});

	test("agent error and permission wait are failures with the reason", async () => {
		const e = fakeClient([
			{ status: "error", final: null, error: "auth failed", lastMessage: null },
		]);
		expect((await runAgentOverPaseo(e.c, task(), never)).stderr).toContain(
			"auth failed",
		);
		const p = fakeClient([
			{ status: "permission", final: null, error: null, lastMessage: null },
		]);
		expect((await runAgentOverPaseo(p.c, task(), never)).stderr).toContain(
			"permission",
		);
	});

	test("a dropped connection: the wait resumes", async () => {
		const { c, calls } = fakeClient([
			new Error("socket closed"),
			idle('{"status":"done","summary":"ok"}'),
		]);
		const r = await runAgentOverPaseo(c, task(), never);
		expect(r.code).toBe(0);
		expect(calls.filter((x) => x.op === "waitForFinish")).toHaveLength(2);
	}, 10_000);

	test("abort cancels the agent", async () => {
		const ac = new AbortController();
		let release: (f: Finish) => void = () => {};
		const { c, calls } = fakeClient([]);
		(c as unknown as { waitForFinish: () => Promise<Finish> }).waitForFinish =
			() =>
				new Promise<Finish>((r) => {
					release = r;
				});
		const p = runAgentOverPaseo(c, task(), ac.signal);
		await Bun.sleep(10);
		ac.abort();
		release(idle(null));
		const r = await p;
		expect(r.code).toBe(130);
		expect(calls).toContainEqual({ op: "cancelAgent", arg: "ag-1" });
	});
});

describe("runInBox with runAgent (mm-210.73)", () => {
	const opts = (d: FakeDriver) => ({
		driver: d,
		defaultImage: "img",
		outDir: out,
		readyCommand: null,
	});

	test("the hook runs the agent: no 'paseo run' exec", async () => {
		const d = new FakeDriver();
		const res = await runInBox(
			task(),
			{
				...opts(d),
				runAgent: async () => ({
					code: 0,
					stdout: '{"status":"done","summary":"via sdk"}',
					stderr: "",
				}),
			},
			never,
		);
		expect(res.summary).toBe("via sdk");
		expect(
			d.execs.some((e) => e.cmd[0] === "paseo" && e.cmd[1] === "run"),
		).toBe(false);
	});

	test("the hook says null: the agent runs through exec", async () => {
		const d = new FakeDriver();
		const res = await runInBox(
			task(),
			{ ...opts(d), runAgent: async () => null },
			never,
		);
		expect(res.summary).toBe("did it");
		expect(
			d.execs.some((e) => e.cmd[0] === "paseo" && e.cmd[1] === "run"),
		).toBe(true);
	});
});

describe("paseoRunAgent over a linked box", () => {
	const linked = (connect: () => Promise<BoxClient>) =>
		linkDriver(new FakeDriver(), {
			dir: join(out, "l"),
			runnerId: "laptop",
			register: false,
			open: async () => {
				throw new Error("no relay in this test");
			},
			ready: async () => true,
			connect,
		});
	const spec = {
		image: "i",
		name: "b",
		labels: { "mastermind.item": "mm-1", "mastermind.execution": "e1" },
	};

	test("uses the box's one connection", async () => {
		const { c, calls } = fakeClient([
			idle('{"status":"done","summary":"ok"}'),
			idle('{"status":"done","summary":"again"}'),
		]);
		let connects = 0;
		const d = linked(async () => {
			connects++;
			return c;
		});
		const box = await d.create(spec);
		const steps: string[] = [];
		const run = paseoRunAgent((_b, l) => steps.push(l));
		expect((await run(box, task(), never))?.code).toBe(0);
		expect((await run(box, task(), never))?.stdout).toContain("again");
		expect(connects).toBe(1);
		expect(steps[0]).toBe("agent ag-1 started through the Paseo connection");
		await box.destroy();
		expect(calls.at(-1)).toEqual({ op: "close" });
	});

	test("no connection: the ticket says so, exec runs the agent", async () => {
		const d = linked(async () => {
			throw new Error("refused");
		});
		const box = await d.create(spec);
		const steps: string[] = [];
		const r = await paseoRunAgent((_b, l) => steps.push(l))(box, task(), never);
		expect(r).toBeNull();
		expect(steps[0]).toContain("refused; the agent runs through exec");
		await box.destroy();
	});

	test("a box not made by linkDriver: exec", async () => {
		const box = await new FakeDriver().create(spec);
		expect(await paseoRunAgent()(box, task(), never)).toBeNull();
	});
});
