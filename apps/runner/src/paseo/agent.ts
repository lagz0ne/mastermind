/**
 * One agent with a structured answer, through the SDK: what
 * `paseo run --output-schema` does (CLI 0.15.4, commands/agent/run.js): a
 * workspace at the cwd, createAgent with the output schema, waitForFinish,
 * the last assistant message checked against the schema, up to 2 retries
 * with the errors. Used for the local agent (launcher.ts) and the box agent
 * (box/paseo-control.ts, over the box relay).
 *
 * A provider that cannot log in does not make the agent fail in Paseo
 * (mm-210.71 Q6): the agent goes idle with lastError null and its only
 * answer is the CLI's text, e.g. Claude Code "Not logged in · Please run
 * /login". That answer ends the run at once (no retries), with the text.
 */
import type { DaemonClient } from "./connect.ts";

/** JSON schema the agent's final answer must match. */
export const RESULT_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["done", "failed"] },
		summary: { type: "string" },
	},
	required: ["status", "summary"],
	additionalProperties: false,
} as const;

/** The SDK calls one structured agent run uses (a fake in tests). */
export type AgentClient = Pick<
	DaemonClient,
	| "createWorkspace"
	| "createAgent"
	| "waitForFinish"
	| "sendMessage"
	| "fetchAgentTimeline"
	| "cancelAgent"
>;

/** Exit code, the `{status, summary}` JSON on stdout, or why not on stderr. */
export type RunOutcome = { code: number; stdout: string; stderr: string };

export type StructuredRun = {
	/** `provider` or `provider/model`. */
	provider: string;
	model?: string;
	/** Absent: the provider's default mode in Paseo. */
	modeId?: string;
	/** The agent's directory; Paseo opens (or reuses) a workspace there. */
	cwd: string;
	title: string;
	prompt: string;
	labels: Record<string, string>;
	/** Extra environment of the agent process (sent over the connection, not argv). */
	env?: Record<string, string>;
};

const MAX_RETRIES = 2;

/**
 * What agent CLIs say when they cannot log in to their provider. Paseo does
 * not report this as an agent error; the text is the agent's only answer.
 */
const PROVIDER_LOGIN =
	/\bnot logged\b|please run \/login|failed to authenticate|oauth access token is invalid|api error: 401\b|invalid api key|invalid x-api-key|authentication_error|oauth token (?:has )?expired|\b401\b[^\n]{0,40}unauthori[sz]ed/i;

/** The provider's auth message in a text, or null. */
export function providerLoginMessage(text: string): string | null {
	return text.match(PROVIDER_LOGIN)?.[0] ?? null;
}

/** `provider` and `model` as Paseo wants them (`claude/haiku` splits). */
export function splitProvider(
	raw: string,
	model?: string,
): { provider: string; model?: string } {
	const p = raw.trim();
	const slash = p.indexOf("/");
	if (slash < 0) return { provider: p, ...(model ? { model } : {}) };
	return { provider: p.slice(0, slash), model: model ?? p.slice(slash + 1) };
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

const fail = (why: string, code = 1): RunOutcome => ({
	code,
	stdout: "",
	stderr: why,
});

/**
 * Run one agent through `c` and wait for its `{status, summary}`. Abort: the
 * agent is cancelled (code 130). The connection may drop and come back (the
 * client reconnects): the wait resumes, up to 5 times.
 */
export async function runStructured(
	c: AgentClient,
	o: StructuredRun,
	signal: AbortSignal,
	opts: { waitTimeoutMs?: number; onAgent?: (agentId: string) => void } = {},
): Promise<RunOutcome> {
	const { provider, model } = splitProvider(o.provider, o.model);
	const ws = await c.createWorkspace({
		source: { kind: "directory", path: o.cwd },
	} as Parameters<AgentClient["createWorkspace"]>[0]);
	if (!ws.workspace)
		return fail(`paseo: no workspace at ${o.cwd}: ${ws.error ?? "?"}`);
	const agent = await c.createAgent({
		provider,
		...(model ? { model } : {}),
		...(o.modeId ? { modeId: o.modeId } : {}),
		cwd: ws.workspace.workspaceDirectory ?? o.cwd,
		workspaceId: ws.workspace.id,
		title: o.title,
		initialPrompt: structuredPrompt(o.prompt),
		outputSchema: RESULT_SCHEMA as unknown as Record<string, unknown>,
		labels: o.labels,
		...(o.env && Object.keys(o.env).length ? { env: o.env } : {}),
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
					"paseo: the agent is waiting for permission before producing structured output",
				);
			if (state.status === "error")
				return fail(
					`paseo: the agent failed: ${state.error ?? "unknown error"}`,
				);
			const answer = await lastAnswer(c, agent.id, state.lastMessage);
			if (!answer) return fail("paseo: the agent finished without an answer");
			const r = readResult(answer);
			if (r.ok) return { code: 0, stdout: JSON.stringify(r.value), stderr: "" };
			// mm-210.72: a provider that cannot log in answers with its CLI's text.
			if (providerLoginMessage(answer))
				return fail(
					`paseo: the agent answered with no result: ${answer.slice(-300)}`,
				);
			if (attempt >= MAX_RETRIES)
				return fail(
					`paseo: the answer does not match the result schema: ${r.errors.join("; ")}: ${answer.slice(-300)}`,
				);
			await c.sendMessage(agent.id, retryPrompt(o.prompt, r.errors));
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
