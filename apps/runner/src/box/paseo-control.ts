/**
 * The agent step of a box through ONE persistent Paseo SDK connection to the
 * box daemon (mm-210.73, verdict of mm-210.71), instead of `docker exec paseo
 * run`. The connection goes over the relay of paseo-link.ts (unix socket ->
 * Docker exec stream -> the daemon at 127.0.0.1:6767 in the box): no password,
 * no published port.
 *
 * What `paseo run --output-schema` does, with the SDK (CLI 0.15.4,
 * commands/agent/run.js): a local workspace at the box workspace, createAgent
 * with the output schema, waitForFinish, the last assistant message checked
 * against the schema, up to 2 retries with the errors. Same result shape as
 * the exec path (an ExecResult whose stdout is `{status, summary}`), so the
 * rest of run.ts does not change.
 */
import type { createHostClient } from "@getpaseo/client/node";
import { RESULT_SCHEMA } from "../launcher.ts";
import { BOX_LABEL, type ExecResult } from "./driver.ts";
import type { BoxTask } from "./run.ts";

type DaemonClient = ReturnType<typeof createHostClient>;

/** The SDK calls the agent step uses (a fake in tests). */
export type AgentClient = Pick<
	DaemonClient,
	| "createWorkspace"
	| "createAgent"
	| "waitForFinish"
	| "sendMessage"
	| "fetchAgentTimeline"
	| "cancelAgent"
>;

/** Workspace of the box agent (run.ts WORKSPACE; no import cycle at load). */
const BOX_WORKSPACE = "/workspace";
const MAX_RETRIES = 2;

/** `provider` or `provider/model` (+ `model`) as Paseo wants them. */
export function providerModel(task: BoxTask): {
	provider: string;
	model?: string;
} {
	const a = task.agent;
	const raw = (
		a.provider ??
		task.env.agent?.provider ??
		task.env.provider ??
		"claude"
	).trim();
	const slash = raw.indexOf("/");
	if (slash < 0)
		return { provider: raw, ...(a.model ? { model: a.model } : {}) };
	return {
		provider: raw.slice(0, slash),
		model: a.model ?? raw.slice(slash + 1),
	};
}

/** The prompt with the result schema, as Paseo's structured response loop builds it. */
export function structuredPrompt(prompt: string): string {
	return [
		prompt.trim(),
		"",
		"You must respond with JSON only that matches this JSON Schema:",
		JSON.stringify(RESULT_SCHEMA, null, 2),
	].join("\n");
}

function retryPrompt(prompt: string, errors: string[]): string {
	return [
		structuredPrompt(prompt),
		"",
		"Previous response was invalid with validation errors:",
		...errors.map((e) => `- ${e}`),
		"",
		"Respond again with JSON only that matches the schema.",
	].join("\n");
}

/** The `{status, summary}` in an answer (plain, fenced or embedded), or the errors. */
export function readResult(
	text: string,
):
	| { ok: true; value: { status: "done" | "failed"; summary: string } }
	| { ok: false; errors: string[] } {
	const t = text.trim();
	const candidates = [t];
	const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
	for (const c of candidates) {
		let v: unknown;
		try {
			v = JSON.parse(c);
		} catch {
			continue;
		}
		const r = v as { status?: unknown; summary?: unknown } | null;
		const errors: string[] = [];
		if (!r || typeof r !== "object") errors.push("(root): must be object");
		else {
			if (r.status !== "done" && r.status !== "failed")
				errors.push("/status: must be equal to one of the allowed values");
			if (typeof r.summary !== "string")
				errors.push("/summary: must be string");
		}
		if (!errors.length)
			return {
				ok: true,
				value: {
					status: r?.status as "done" | "failed",
					summary: r?.summary as string,
				},
			};
		return { ok: false, errors };
	}
	return { ok: false, errors: ["(root): the answer is not JSON"] };
}

async function lastAnswer(
	c: AgentClient,
	agentId: string,
	direct: string | null,
): Promise<string | null> {
	if (direct?.trim()) return direct.trim();
	try {
		const t = await c.fetchAgentTimeline(agentId, {
			direction: "tail",
			limit: 200,
		});
		for (let i = t.entries.length - 1; i >= 0; i--) {
			const item = t.entries[i]?.item as
				| { type?: string; text?: string }
				| undefined;
			if (item?.type === "assistant_message" && item.text?.trim())
				return item.text.trim();
		}
	} catch {}
	return null;
}

const fail = (why: string, code = 1): ExecResult => ({
	code,
	stdout: "",
	stderr: why,
});

/**
 * Run the task's agent in the box through `c` and wait for its result.
 * Abort: the agent is cancelled. The connection may drop and come back
 * (the client reconnects): the wait resumes, up to 5 times.
 */
export async function runAgentOverPaseo(
	c: AgentClient,
	task: BoxTask,
	signal: AbortSignal,
	opts: { waitTimeoutMs?: number; onAgent?: (agentId: string) => void } = {},
): Promise<ExecResult> {
	const { provider, model } = providerModel(task);
	const a = task.agent;
	const ws = await c.createWorkspace({
		source: { kind: "directory", path: BOX_WORKSPACE },
	} as Parameters<AgentClient["createWorkspace"]>[0]);
	if (!ws.workspace)
		return fail(`paseo: no workspace at ${BOX_WORKSPACE}: ${ws.error ?? "?"}`);
	const agent = await c.createAgent({
		provider,
		...(model ? { model } : {}),
		modeId: a.mode ?? task.env.agent?.mode ?? "bypassPermissions",
		cwd: ws.workspace.workspaceDirectory ?? BOX_WORKSPACE,
		workspaceId: ws.workspace.id,
		title: task.title,
		initialPrompt: structuredPrompt(task.prompt),
		outputSchema: RESULT_SCHEMA as unknown as Record<string, unknown>,
		labels: {
			...task.labels,
			[BOX_LABEL.execution]: task.executionId,
			"mastermind.bead": task.beadId,
		},
	} as Parameters<AgentClient["createAgent"]>[0]);
	opts.onAgent?.(agent.id);
	const cancel = () => void c.cancelAgent(agent.id).catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (let attempt = 0; ; attempt++) {
			const state = await waitResilient(
				c,
				agent.id,
				signal,
				opts.waitTimeoutMs,
			);
			if (signal.aborted) return fail("stopped", 130);
			if (state.status === "timeout")
				return fail("paseo: timed out waiting for the agent");
			if (state.status === "permission")
				return fail(
					"paseo: the agent waits for a permission (mode bypass expected)",
				);
			if (state.status === "error")
				return fail(
					`paseo: the agent failed: ${state.error ?? "unknown error"}`,
				);
			const answer = await lastAnswer(c, agent.id, state.lastMessage);
			if (!answer) return fail("paseo: the agent finished without an answer");
			const r = readResult(answer);
			if (r.ok) return { code: 0, stdout: JSON.stringify(r.value), stderr: "" };
			if (attempt >= MAX_RETRIES)
				return fail(
					`paseo: the answer does not match the result schema: ${r.errors.join("; ")}: ${answer.slice(-300)}`,
				);
			await c.sendMessage(agent.id, retryPrompt(task.prompt, r.errors));
		}
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

type Finish = Awaited<ReturnType<AgentClient["waitForFinish"]>>;

async function waitResilient(
	c: AgentClient,
	agentId: string,
	signal: AbortSignal,
	timeoutMs?: number,
): Promise<Finish> {
	for (let drops = 0; ; drops++) {
		try {
			return await c.waitForFinish(agentId, timeoutMs);
		} catch (error) {
			if (signal.aborted || drops >= 5) throw error;
			await Bun.sleep(2000);
		}
	}
}

/** The SDK calls a terminal command uses (a fake in tests). */
export type TerminalClient = Pick<
	DaemonClient,
	"createWorkspace" | "createTerminal" | "captureTerminal" | "killTerminal"
>;

/** The Paseo workspace at `path` in the box (created once; Paseo reuses it). */
export async function workspaceAt(
	c: Pick<DaemonClient, "createWorkspace">,
	path: string,
): Promise<{ id: string; dir: string } | { error: string }> {
	const ws = await c.createWorkspace({
		source: { kind: "directory", path },
	} as Parameters<DaemonClient["createWorkspace"]>[0]);
	if (!ws.workspace) return { error: ws.error ?? "?" };
	return { id: ws.workspace.id, dir: ws.workspace.workspaceDirectory ?? path };
}

/** Terminal width: wide, so long lines rarely wrap (they still can). */
const COLS = 500;

/**
 * One setup/check command in a Paseo terminal of the box (mm-210.74, verdict
 * of mm-210.71): `sh -c '( <cmd> ) 2>&1; printf <marker><code>'`, then the
 * terminal is read until the marker and killed (its scrollback goes with
 * it). Like the Expect/tmux marker pattern: stdout and stderr come mixed, a
 * line wider than {@link COLS} wraps, no stdin. Only for commands that hold
 * no secret and need only text output and the exit code; the credential
 * clone and the git bundle stay on Docker exec (mm-210.64).
 */
export async function runCommandOverPaseo(
	c: TerminalClient,
	cmd: string,
	o: {
		cwd: string;
		signal: AbortSignal;
		/** Default 60 min. */
		timeoutMs?: number;
		/** Poll interval; default 250 ms. */
		pollMs?: number;
	},
): Promise<ExecResult> {
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const marker = `__MM_EXIT_${nonce}_`;
	// The marker is printed in two parts, so the command line itself (echoed
	// by nothing, but kept in `ps`) never matches it.
	const wrapped = `( ${cmd}\n) 2>&1; printf '\\n%s%s%s\\n' '__MM_EXIT_' '${nonce}_' "$?"; exec sleep 600`;
	const ws = await workspaceAt(c, o.cwd);
	if ("error" in ws)
		return fail(`paseo: no workspace at ${o.cwd}: ${ws.error}`);
	const created = await c.createTerminal(
		o.cwd,
		"mastermind: setup",
		undefined,
		{
			workspaceId: ws.id,
			command: "sh",
			args: ["-c", wrapped],
			size: { rows: 50, cols: COLS },
		},
	);
	const id = created.terminal?.id;
	if (!id) return fail(`paseo terminal: ${created.error ?? "not created"}`);
	const until = Date.now() + (o.timeoutMs ?? 60 * 60_000);
	try {
		for (;;) {
			if (o.signal.aborted) return fail("stopped", 130);
			const cap = await c.captureTerminal(id, { stripAnsi: true });
			const lines = cap.lines.map((l) => l.trimEnd());
			const at = lines.findIndex((l) => l.startsWith(marker));
			if (at >= 0) {
				const code = Number(lines[at]?.slice(marker.length));
				let out = lines.slice(0, at);
				while (out.length && out[out.length - 1] === "") out = out.slice(0, -1);
				return {
					code: Number.isInteger(code) ? code : 1,
					stdout: out.join("\n"),
					stderr: "",
				};
			}
			if (Date.now() > until)
				return fail(`paseo terminal: \`${cmd}\` did not end in time`, 124);
			await Bun.sleep(o.pollMs ?? 250);
		}
	} finally {
		await c.killTerminal(id).catch(() => {});
	}
}

/** The SDK calls the item's files use (a fake in tests). */
export type FileClient = Pick<
	DaemonClient,
	| "readFile"
	| "writeFile"
	| "createFileEntry"
	| "listDirectory"
	| "getLastServerInfoMessage"
>;

/** Paseo's writeFile limit (server MAX_EDITABLE_FILE_BYTES). */
export const PASEO_WRITE_MAX = 1024 * 1024;
/** Larger outputs go through the Docker stream (readFile holds a file in memory). */
export const PASEO_READ_MAX = 64 * 1024 * 1024;

/** Box path -> path in the workspace; null when outside it (Paseo cannot reach it). */
function inWorkspace(path: string): string | null {
	const p = path.replace(/\/+$/, "");
	return p.startsWith(`${BOX_WORKSPACE}/`) && !p.split("/").includes("..")
		? p.slice(BOX_WORKSPACE.length + 1)
		: null;
}

/**
 * The regular files in `dir` (names), like the exec listing (mm-210.75).
 * undefined: not through Paseo (outside the workspace).
 */
export async function listFilesOverPaseo(
	c: FileClient,
	dir: string,
): Promise<string[] | undefined> {
	const rel = inWorkspace(dir);
	if (rel === null) return undefined;
	try {
		const d = await c.listDirectory(BOX_WORKSPACE, rel);
		return (d.entries ?? [])
			.filter((e: { kind?: string }) => e.kind === "file")
			.map((e: { name: string }) => e.name);
	} catch (error) {
		if (/ENOENT/.test(String(error))) return [];
		throw error;
	}
}

/**
 * One file out of the box with readFile. null: no such file. undefined: not
 * through Paseo (outside the workspace, or over {@link PASEO_READ_MAX}).
 */
export async function readFileOverPaseo(
	c: FileClient,
	path: string,
): Promise<
	{ size: number; data: ReadableStream<Uint8Array> } | null | undefined
> {
	const rel = inWorkspace(path);
	if (rel === null) return undefined;
	try {
		const f = await c.readFile(BOX_WORKSPACE, rel, undefined, PASEO_READ_MAX);
		return { size: f.size, data: new Blob([f.bytes]).stream() };
	} catch (error) {
		const m = String(error);
		if (/ENOENT/.test(m)) return null;
		if (/too large/i.test(m)) return undefined;
		throw error;
	}
}

/**
 * One file into directory `dir` of the box with writeFile (new file, then
 * the bytes with the version it has; one retry on a conflict). false: not
 * through Paseo (over {@link PASEO_WRITE_MAX}, outside the workspace, or a
 * daemon without byte writes).
 */
export async function writeFileOverPaseo(
	c: FileClient,
	dir: string,
	name: string,
	bytes: Uint8Array,
): Promise<boolean> {
	const rel = inWorkspace(dir);
	const features = c.getLastServerInfoMessage()?.features as
		| Record<string, unknown>
		| undefined;
	if (
		rel === null ||
		bytes.length > PASEO_WRITE_MAX ||
		features?.fileByteWrites !== true
	)
		return false;
	const path = `${rel}/${name}`;
	const made = await c.createFileEntry({
		cwd: BOX_WORKSPACE,
		parentPath: rel,
		name,
		kind: "file",
	});
	if (!made.success && !/exist/i.test(made.error ?? "")) return false;
	const content = Buffer.from(bytes).toString("base64");
	for (let i = 0; i < 2; i++) {
		const cur = await c.readFile(BOX_WORKSPACE, path);
		const w = await c.writeFile({
			cwd: BOX_WORKSPACE,
			path,
			content,
			contentEncoding: "base64",
			expectedModifiedAt: cur.modifiedAt,
			...(cur.revision ? { expectedRevision: cur.revision } : {}),
		});
		if ((w as { status?: string }).status === "written") return true;
	}
	return false;
}
