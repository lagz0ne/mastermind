import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileInfo } from "@mastermind/bus";
import { OUTPUTS_DIR } from "@mastermind/core";
import type { BoxFiles } from "../../src/box/files.ts";
import { paseoRunAgent } from "../../src/box/launcher.ts";
import {
	type AgentClient,
	listFilesOverPaseo,
	PASEO_READ_MAX,
	PASEO_WRITE_MAX,
	providerModel,
	readFileOverPaseo,
	readResult,
	runAgentOverPaseo,
	runCommandOverPaseo,
	structuredPrompt,
	writeFileOverPaseo,
} from "../../src/box/paseo-control.ts";
import { type BoxClient, linkDriver } from "../../src/box/paseo-link.ts";
import {
	type BoxFileHooks,
	type BoxTask,
	FILE_HOOK_MAX,
	runInBox,
} from "../../src/box/run.ts";
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

/** A fake terminal: shows `lines` after `after` captures; the marker from the real nonce. */
function fakeTerminal(output: string[], code: number | null, after = 1) {
	const calls: string[] = [];
	let wrapped = "";
	let n = 0;
	const c = {
		createWorkspace: async () => ({
			workspace: { id: "ws-1", workspaceDirectory: "/workspace" },
			error: null,
		}),
		createTerminal: async (
			_cwd: string,
			_name: string,
			_r: unknown,
			o: { args: string[]; workspaceId: string },
		) => {
			wrapped = o.args[1] ?? "";
			calls.push(`create ${o.workspaceId}`);
			return { terminal: { id: "t-1" }, error: null };
		},
		captureTerminal: async () => {
			calls.push("capture");
			const nonce = wrapped.match(/'__MM_EXIT_' '([0-9a-f]+)_'/)?.[1];
			const done = ++n > after && code !== null;
			return {
				lines: [...output, ...(done ? [`__MM_EXIT_${nonce}_${code}`, ""] : [])],
			};
		},
		killTerminal: async () => {
			calls.push("kill");
			return {};
		},
	};
	return { c: c as unknown as BoxClient, calls, wrapped: () => wrapped };
}

describe("runCommandOverPaseo (mm-210.74)", () => {
	const o = (signal = never) => ({ cwd: "/workspace", signal, pollMs: 1 });
	test("output before the marker, the exit code; the terminal is killed", async () => {
		const t = fakeTerminal(["out", "err   "], 3);
		const r = await runCommandOverPaseo(t.c, "make test", o());
		expect(r).toEqual({ code: 3, stdout: "out\nerr", stderr: "" });
		expect(t.wrapped()).toContain("( make test\n) 2>&1");
		expect(t.calls[0]).toBe("create ws-1");
		expect(t.calls.at(-1)).toBe("kill");
	});

	test("a line that looks like a marker without the nonce is output", async () => {
		const t = fakeTerminal(["__MM_EXIT_fake_0"], 0);
		const r = await runCommandOverPaseo(t.c, "x", o());
		expect(r.stdout).toBe("__MM_EXIT_fake_0");
	});

	test("abort: 130 and the terminal is killed", async () => {
		const t = fakeTerminal(["..."], null);
		const ac = new AbortController();
		const p = runCommandOverPaseo(t.c, "sleep 99", o(ac.signal));
		await Bun.sleep(5);
		ac.abort();
		expect((await p).code).toBe(130);
		expect(t.calls.at(-1)).toBe("kill");
	});

	test("no terminal: the reason", async () => {
		const t = fakeTerminal([], 0);
		(t.c as unknown as { createTerminal: () => unknown }).createTerminal =
			async () => ({ terminal: null, error: "denied" });
		expect((await runCommandOverPaseo(t.c, "x", o())).stderr).toContain(
			"denied",
		);
	});
});

describe("runInBox with runCommand (mm-210.74)", () => {
	const base = (d: FakeDriver) => ({
		driver: d,
		defaultImage: "img",
		outDir: out,
		readyCommand: null,
	});
	const withSetup = () =>
		task({
			env: { ...task().env, setup: ["bun install"], check: ["bun test"] },
		});

	test("setup and check through the hook, not exec", async () => {
		const d = new FakeDriver();
		const seen: string[] = [];
		const res = await runInBox(
			withSetup(),
			{
				...base(d),
				runCommand: async (_b, cmd) => {
					seen.push(cmd);
					return { code: 0, stdout: "", stderr: "" };
				},
			},
			never,
		);
		expect(res.status).toBe("done");
		expect(seen).toEqual(["bun install", "bun test"]);
		expect(d.execs.some((e) => e.cmd.join(" ") === "sh -c bun install")).toBe(
			false,
		);
	});

	test("a failing check stops the task with the output tail", async () => {
		const d = new FakeDriver();
		await expect(
			runInBox(
				withSetup(),
				{
					...base(d),
					runCommand: async (_b, cmd) =>
						cmd === "bun test"
							? { code: 1, stdout: "1 test failed", stderr: "" }
							: { code: 0, stdout: "", stderr: "" },
				},
				never,
			),
		).rejects.toThrow("check `bun test` exited 1: 1 test failed");
	});

	test("the hook says null: exec", async () => {
		const d = new FakeDriver();
		await runInBox(
			withSetup(),
			{ ...base(d), runCommand: async () => null },
			never,
		);
		expect(d.execs.some((e) => e.cmd.join(" ") === "sh -c bun install")).toBe(
			true,
		);
	});
});

/** A fake file client over an in-memory workspace (paths relative to /workspace). */
function fakeFs(files: Record<string, Uint8Array> = {}, byteWrites = true) {
	const calls: string[] = [];
	const meta: Record<string, number> = {};
	const c = {
		getLastServerInfoMessage: () => ({
			features: byteWrites ? { fileByteWrites: true } : {},
		}),
		listDirectory: async (_cwd: string, rel: string) => {
			calls.push(`ls ${rel}`);
			return {
				entries: [
					...Object.keys(files)
						.filter((p) => p.startsWith(`${rel}/`))
						.map((p) => ({ name: p.slice(rel.length + 1), kind: "file" })),
					{ name: "sub", kind: "directory" },
				],
			};
		},
		readFile: async (_cwd: string, rel: string, _r?: string, max?: number) => {
			calls.push(`read ${rel}`);
			const f = files[rel];
			if (!f) throw new Error(`ENOENT: no such file, open '/workspace/${rel}'`);
			if (max !== undefined && f.length > max)
				throw new Error("File is too large to display");
			meta[rel] ??= 1;
			return {
				bytes: f,
				size: f.length,
				modifiedAt: `t${meta[rel]}`,
				revision: `r${meta[rel]}`,
			};
		},
		createFileEntry: async (i: { parentPath: string; name: string }) => {
			const p = `${i.parentPath}/${i.name}`;
			calls.push(`create ${p}`);
			files[p] ??= new Uint8Array();
			return { success: true, error: null };
		},
		writeFile: async (i: {
			path: string;
			content: string;
			expectedModifiedAt: string;
		}) => {
			calls.push(`write ${i.path} at ${i.expectedModifiedAt}`);
			files[i.path] = new Uint8Array(Buffer.from(i.content, "base64"));
			meta[i.path] = (meta[i.path] ?? 1) + 1;
			return { status: "written" };
		},
	};
	return { c: c as unknown as BoxClient, calls, files };
}

describe("files over Paseo (mm-210.75)", () => {
	const enc = (s: string) => new TextEncoder().encode(s);

	test("list: regular files only; outside the workspace: not through Paseo", async () => {
		const { c } = fakeFs({ ".mastermind/out/a.md": enc("a") });
		expect(await listFilesOverPaseo(c, "/workspace/.mastermind/out")).toEqual([
			"a.md",
		]);
		expect(await listFilesOverPaseo(c, "/tmp")).toBeUndefined();
		expect(await listFilesOverPaseo(c, "/workspace/../etc")).toBeUndefined();
	});

	test("read: bytes; missing: null; too large or outside: undefined", async () => {
		const { c } = fakeFs({
			".mastermind/out/a.md": enc("hello"),
			".mastermind/out/huge": new Uint8Array(PASEO_READ_MAX + 1),
		});
		const f = await readFileOverPaseo(c, "/workspace/.mastermind/out/a.md");
		expect(f?.size).toBe(5);
		expect(await new Response(f?.data).text()).toBe("hello");
		expect(
			await readFileOverPaseo(c, "/workspace/.mastermind/out/nope"),
		).toBeNull();
		expect(
			await readFileOverPaseo(c, "/workspace/.mastermind/out/huge"),
		).toBeUndefined();
		expect(await readFileOverPaseo(c, "/tmp/x.patch")).toBeUndefined();
	});

	test("write: create, then the bytes at the version it has", async () => {
		const { c, calls, files } = fakeFs();
		expect(
			await writeFileOverPaseo(
				c,
				"/workspace/.mastermind/in",
				"d.csv",
				enc("a,b"),
			),
		).toBe(true);
		expect(calls).toEqual([
			"create .mastermind/in/d.csv",
			"read .mastermind/in/d.csv",
			"write .mastermind/in/d.csv at t1",
		]);
		expect(new TextDecoder().decode(files[".mastermind/in/d.csv"])).toBe("a,b");
	});

	test("write: over 1 MiB, outside, or no byte writes: not through Paseo", async () => {
		const big = new Uint8Array(PASEO_WRITE_MAX + 1);
		expect(
			await writeFileOverPaseo(fakeFs().c, "/workspace/in", "b", big),
		).toBe(false);
		expect(await writeFileOverPaseo(fakeFs().c, "/tmp", "b", enc("x"))).toBe(
			false,
		);
		expect(
			await writeFileOverPaseo(
				fakeFs({}, false).c,
				"/workspace/in",
				"b",
				enc("x"),
			),
		).toBe(false);
	});
});

class FakeFiles implements BoxFiles {
	written: { name: string; text: string }[] = [];
	constructor(readonly inputs: Record<string, string>) {}
	async stage() {
		return Object.entries(this.inputs).map(([name, t]) => ({
			name,
			dir: "in" as const,
			size: t.length,
			sha256: "x",
			mtime: "",
		}));
	}
	async read(_b: string, name: string) {
		const t = this.inputs[name];
		return t === undefined
			? null
			: { size: t.length, data: new Blob([t]).stream() };
	}
	async write(_b: string, name: string, data: ReadableStream<Uint8Array>) {
		this.written.push({ name, text: await new Response(data).text() });
		return { name } as FileInfo;
	}
	async out() {
		return [];
	}
}

describe("runInBox with boxFiles (mm-210.75)", () => {
	const big = "x".repeat(FILE_HOOK_MAX + 1);
	const run = (d: FakeDriver, io: FakeFiles, hooks: BoxFileHooks) =>
		runInBox(
			task(),
			{
				driver: d,
				defaultImage: "img",
				outDir: out,
				readyCommand: null,
				files: () => io,
				boxFiles: hooks,
			},
			never,
		);

	test("small inputs and outputs through the hooks; big inputs and /tmp through Docker", async () => {
		const d = new FakeDriver();
		const io = new FakeFiles({ "small.csv": "a,b", "big.bin": big });
		const put: string[] = [];
		const took: string[] = [];
		await run(d, io, {
			list: async () => ["report.md"],
			take: async (_b, path) => {
				took.push(path);
				return path.startsWith("/workspace/")
					? { size: 2, data: new Blob(["ok"]).stream() }
					: undefined;
			},
			put: async (_b, _dir, name) => {
				put.push(name);
				return true;
			},
		});
		expect(put).toEqual(["small.csv"]);
		expect(d.copiedIn.flatMap((c) => c.names)).toContain("big.bin");
		expect(d.copiedIn.flatMap((c) => c.names)).not.toContain("small.csv");
		expect(took).toContain(`${OUTPUTS_DIR}/report.md`);
		expect(io.written.find((w) => w.name === "report.md")?.text).toBe("ok");
		// The outputs listing did not go through exec.
		expect(d.execs.some((e) => e.cmd[3] === "list")).toBe(false);
	});

	test("hooks that cannot (or fail): everything through Docker", async () => {
		const d = new FakeDriver();
		const io = new FakeFiles({ "small.csv": "a,b" });
		await run(d, io, {
			list: async () => undefined,
			take: async () => {
				throw new Error("socket closed");
			},
			put: async () => false,
		});
		expect(d.copiedIn.flatMap((c) => c.names)).toContain("small.csv");
		expect(d.execs.some((e) => e.cmd[3] === "list")).toBe(true);
	});
});
