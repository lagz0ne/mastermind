/**
 * How the runner starts an agent and gets its result. The default is Paseo
 * (`paseo run`); tests and other agent hosts plug in their own launcher.
 */
import type { DispatchEnv } from "@mastermind/core";
import type { AgentSettings } from "./config.ts";

export type AgentSpec = {
	/**
	 * Durable id of this execution (bead + claim). A launcher must never run
	 * two agents for one execution id.
	 */
	executionId: string;
	beadId: string;
	title: string;
	/** Absolute working directory. */
	cwd: string;
	prompt: string;
	agent: AgentSettings;
	/** Extra labels for the agent (the launcher adds its own). */
	labels?: Record<string, string>;
	/** `paseo --host` of the routed target; default: the launcher's host. */
	host?: string;
	/** Environment for the agent process (the declared secrets). */
	env?: Record<string, string>;
	/** The dispatch's environment (the box recipe), for launchers that make a box. */
	recipe?: DispatchEnv;
};

/** What the agent says it did. Completion comes from the agent, not from idle. */
export type AgentResult = { status: "done" | "failed"; summary: string };

export interface AgentLauncher {
	/** Start the agent, wait for it, return its result. Abort stops it. */
	run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult>;
}

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

/** Labels that mark an agent as started by this runner for Mastermind. */
export const LABEL = {
	execution: "mastermind.execution",
	bead: "mastermind.bead",
} as const;

export class LaunchError extends Error {
	override name = "LaunchError";
}

/**
 * Why `paseo run` failed, from its JSON error on stdout
 * ({error: {code, message, details}}) or else stderr, with a fix when known.
 */
export function runFailure(res: {
	code: number;
	stdout: string;
	stderr: string;
}): string {
	let err: { code?: string; message?: string; details?: string } | undefined;
	try {
		err = (JSON.parse(res.stdout.trim()) as { error?: typeof err }).error;
	} catch {}
	const text = err
		? [err.code, err.message, err.details].filter(Boolean).join(": ")
		: res.stderr.trim();
	const fix = /waiting for permission/i.test(text)
		? " (the agent mode asks for permission; fix: mastermind-runner start --mode auto --save)"
		: "";
	return `paseo run exited ${res.code}: ${text.slice(-500)}${fix}`;
}

export function parseResult(stdout: string): AgentResult {
	let v: unknown;
	try {
		v = JSON.parse(stdout.trim());
	} catch {
		throw new LaunchError(`agent output is not JSON: ${stdout.slice(-300)}`);
	}
	const r = v as Partial<AgentResult> | null;
	if (
		!r ||
		(r.status !== "done" && r.status !== "failed") ||
		typeof r.summary !== "string"
	) {
		throw new LaunchError(`agent output has no status and summary`);
	}
	return { status: r.status, summary: r.summary };
}

export type PaseoOptions = {
	/** The paseo CLI as argv. Default `["paseo"]`. */
	command?: string[];
	/** `--host` of the Paseo daemon; default: the local home. */
	host?: string;
	/** Extra environment for the CLI. */
	env?: Record<string, string>;
};

/**
 * Runs agents with the Paseo CLI:
 *
 *   paseo ls -a -g --label mastermind.execution=<id> --json   (never twice)
 *   paseo run --json --output-schema <RESULT_SCHEMA> --cwd ... --label ... <prompt>
 *   paseo stop <agent>                                        (on abort)
 *
 * The CLI runs without PASEO_AGENT_ID/PASEO_AGENT_CWD: when the runner itself
 * runs inside a Paseo agent, those would put the new agent in the caller's
 * workspace instead of `--cwd`.
 */
export class PaseoLauncher implements AgentLauncher {
	readonly #cmd: string[];
	readonly #opts: PaseoOptions;

	constructor(opts: PaseoOptions = {}) {
		this.#cmd = opts.command ?? ["paseo"];
		this.#opts = opts;
	}

	#env(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env))
			if (v !== undefined && k !== "PASEO_AGENT_ID" && k !== "PASEO_AGENT_CWD")
				env[k] = v;
		return { ...env, ...this.#opts.env };
	}

	#host(host = this.#opts.host): string[] {
		return host ? ["--host", host] : [];
	}

	async #exec(args: string[], signal?: AbortSignal) {
		const proc = Bun.spawn([...this.#cmd, ...args], {
			env: this.#env(),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			signal,
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { code: await proc.exited, stdout, stderr };
	}

	/** Ids of agents labelled with this execution id. */
	async find(executionId: string, host?: string): Promise<string[]> {
		const res = await this.#exec([
			"ls",
			"-a",
			"-g",
			"--label",
			`${LABEL.execution}=${executionId}`,
			"--json",
			...this.#host(host),
		]);
		if (res.code !== 0)
			throw new LaunchError(`paseo ls failed: ${res.stderr.trim()}`);
		const list = JSON.parse(res.stdout || "[]") as { id: string }[];
		return list.map((a) => a.id);
	}

	async run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult> {
		if (signal.aborted) throw new LaunchError("agent stopped");
		if ((await this.find(spec.executionId, spec.host)).length > 0) {
			throw new LaunchError(
				`an agent for execution ${spec.executionId} already exists`,
			);
		}
		const labels = {
			...spec.labels,
			[LABEL.execution]: spec.executionId,
			[LABEL.bead]: spec.beadId,
		};
		const a = spec.agent;
		const args = [
			"run",
			"--json",
			"--output-schema",
			JSON.stringify(RESULT_SCHEMA),
			"--title",
			spec.title,
			"--cwd",
			spec.cwd,
			...(a.provider ? ["--provider", a.provider] : []),
			...(a.model ? ["--model", a.model] : []),
			...(a.mode ? ["--mode", a.mode] : []),
			...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
			...Object.entries(spec.env ?? {}).flatMap(([k, v]) => [
				"--env",
				`${k}=${v}`,
			]),
			...this.#host(spec.host),
			spec.prompt,
		];
		const child = new AbortController();
		const onAbort = () => child.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const res = await this.#exec(args, child.signal);
			if (signal.aborted) {
				await this.#stop(spec.executionId, spec.host);
				throw new LaunchError("agent stopped");
			}
			if (res.code !== 0) {
				throw new LaunchError(runFailure(res));
			}
			return parseResult(res.stdout);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async #stop(executionId: string, host?: string): Promise<void> {
		const ids = await this.find(executionId, host).catch(() => []);
		await Promise.all(
			ids.map((id) =>
				this.#exec(["stop", id, ...this.#host(host)]).catch(() => {}),
			),
		);
	}
}
