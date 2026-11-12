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
