/**
 * How the runner starts an agent and gets its result. The default is Paseo,
 * through the SDK (paseo/client.ts); tests and other agent hosts plug in
 * their own launcher.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchEnv, WorkOutput } from "@mastermind/core";
import type { AgentSettings } from "./config.ts";
import {
	providerLoginMessage,
	RESULT_SCHEMA,
	splitProvider,
} from "./paseo/agent.ts";
import {
	connectPaseo,
	type PaseoConnect,
	paseoMessage,
} from "./paseo/client.ts";

export { providerLoginMessage, RESULT_SCHEMA };

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

/**
 * What the agent says it did. Completion comes from the agent, not from idle.
 * `output`: what left the box through the git host (box launcher only).
 */
export type AgentResult = {
	status: "done" | "failed";
	summary: string;
	output?: WorkOutput;
	/**
	 * The agent finished but its work could not be delivered (push or pull
	 * request failed for good): Mastermind holds the item for a human.
	 */
	hold?: boolean;
};

export interface AgentLauncher {
	/** Start the agent, wait for it, return its result. Abort stops it. */
	run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult>;
}

/** Labels that mark an agent as started by this runner for Mastermind. */
export const LABEL = {
	execution: "mastermind.execution",
	bead: "mastermind.bead",
} as const;

export class LaunchError extends Error {
	override name = "LaunchError";
}

/** The fix line for a provider login failure (box: runner secrets; --no-box: this machine's login). */
export const PROVIDER_LOGIN_FIX =
	"mastermind-runner onboard (Claude login), or mastermind-runner secrets set ANTHROPIC_API_KEY (or the key of your provider); with --no-box: log the provider in on this machine";

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
	return agentFailure(text, `paseo run exited ${res.code}`);
}

/** Why an agent run failed (`how`: what failed), with a fix when known. */
export function agentFailure(text: string, how: string): string {
	const login = providerLoginMessage(text);
	if (login)
		return `provider login failed: the agent's provider answered "${login}" (${how}: ${text.slice(-300)}); fix: ${PROVIDER_LOGIN_FIX}`;
	const fix = /waiting for permission/i.test(text)
		? " (the agent mode asks for permission; fix: mastermind-runner start --mode auto --save)"
		: "";
	return `${how}: ${text.slice(-500)}${fix}`;
}

/** The agent's own answer: status and summary (the box adds the output). */
export function parseResult(stdout: string): Omit<AgentResult, "output"> {
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

/** Env vars that tell a `--no-box` agent where its secrets are (paths only). */
export const SECRETS_ENV = {
	dir: "MASTERMIND_SECRETS_DIR",
	file: "MASTERMIND_ENV_FILE",
} as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `--no-box` agent gets its secrets as files in a private directory (0700,
 * files 0600): `<dir>/<NAME>` holds one value and `<dir>/env` exports them
 * all for a shell. Only the two paths go to Paseo (the agent's environment),
 * never a value: no value in the daemon's create request, its agent record
 * or `ps`. The caller deletes the directory when the agent ends.
 */
export function writeSecretsDir(env: Record<string, string>): {
	dir: string;
	names: string[];
} {
	const dir = mkdtempSync(join(tmpdir(), "mastermind-secrets-"));
	chmodSync(dir, 0o700);
	const names = Object.keys(env).filter((k) => ENV_NAME.test(k));
	const sh = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
	for (const k of names)
		writeFileSync(join(dir, k), env[k] as string, { mode: 0o600 });
	writeFileSync(
		join(dir, "env"),
		names.map((k) => `export ${k}=${sh(env[k] as string)}\n`).join(""),
		{ mode: 0o600 },
	);
	return { dir, names };
}

/** The `paseo run` arguments that point the agent at a secrets directory. */
export function secretsArgs(dir: string): string[] {
	return [
		"--env",
		`${SECRETS_ENV.dir}=${dir}`,
		"--env",
		`${SECRETS_ENV.file}=${join(dir, "env")}`,
	];
}

/** The agent environment that points it at a secrets directory (paths only). */
export function secretsEnv(dir: string): Record<string, string> {
	return {
		[SECRETS_ENV.dir]: dir,
		[SECRETS_ENV.file]: join(dir, "env"),
	};
}

/** The prompt lines that tell the agent how to use its secrets. */
export function secretsPrompt(names: string[]): string {
	return `

Secrets for this task (${names.join(", ")}) are NOT in your environment. In a shell
command that needs them, first run: . "$${SECRETS_ENV.file}"
Or read one value from "$${SECRETS_ENV.dir}/<NAME>". Never print a value.`;
}

/** True when `--host` is this machine (a path there is the same file). */
export function isLocalHost(host: string | undefined): boolean {
	if (!host) return true;
	if (host.startsWith("/") || host.startsWith("unix:")) return true;
	const name = host
		.replace(/^[a-z]+:\/\//, "")
		.replace(/:\d+$/, "")
		.replace(/^\[|\]$/g, "");
	return ["localhost", "127.0.0.1", "::1"].includes(name);
}

export type PaseoOptions = {
	/** The Paseo daemon of agents with no routed host; default: the local home. */
	host?: string;
	/** How to reach a daemon; default: the SDK ({@link connectPaseo}). */
	connect?: PaseoConnect;
};

/**
 * Runs agents through the Paseo SDK, one connection per run:
 *
 *   agents with label mastermind.execution=<id>   (never twice)
 *   a structured run (paseo/agent.ts): workspace at cwd, createAgent with the
 *   result schema, wait, read the answer
 *   cancel (on abort)
 *
 * Unlike the CLI, nothing comes from the runner's own environment
 * (PASEO_AGENT_ID / PASEO_AGENT_CWD): the agent gets exactly `cwd`.
 */
export class PaseoLauncher implements AgentLauncher {
	readonly #opts: PaseoOptions;
	readonly #connect: PaseoConnect;

	constructor(opts: PaseoOptions = {}) {
		this.#opts = opts;
		this.#connect = opts.connect ?? connectPaseo;
	}

	async #open(host: string | undefined, reconnect = false) {
		try {
			return await this.#connect(host ?? this.#opts.host, { reconnect });
		} catch (error) {
			throw new LaunchError(`paseo: ${paseoMessage(error)}`);
		}
	}

	/** Ids of agents labelled with this execution id. */
	async find(executionId: string, host?: string): Promise<string[]> {
		const p = await this.#open(host);
		try {
			return await p.agentIds({ [LABEL.execution]: executionId });
		} catch (error) {
			throw new LaunchError(
				`paseo: cannot list agents: ${paseoMessage(error)}`,
			);
		} finally {
			await p.close();
		}
	}

	async run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult> {
		if (signal.aborted) throw new LaunchError("agent stopped");
		if ((await this.find(spec.executionId, spec.host)).length > 0) {
			throw new LaunchError(
				`an agent for execution ${spec.executionId} already exists`,
			);
		}
		const secrets = Object.keys(spec.env ?? {}).length > 0;
		if (secrets && !isLocalHost(spec.host)) {
			throw new LaunchError(
				`secrets are files on this machine; the Paseo host ${spec.host} cannot read them: run this task in a box, or route it to a target on this machine`,
			);
		}
		const a = spec.agent;
		if (!a.provider)
			throw new LaunchError(
				"no provider for the agent; fix: mastermind-runner start --provider <provider> --save (or set provider on the target or rule)",
			);
		const p = await this.#open(spec.host, true);
		// Written last: nothing above can throw and leave it behind.
		const vault = secrets ? writeSecretsDir(spec.env ?? {}) : undefined;
		try {
			const { provider, model } = splitProvider(a.provider, a.model);
			const r = await p.runAgent(
				{
					provider,
					...(model ? { model } : {}),
					...(a.mode ? { modeId: a.mode } : {}),
					cwd: spec.cwd,
					title: spec.title,
					prompt: vault
						? spec.prompt + secretsPrompt(vault.names)
						: spec.prompt,
					labels: {
						...spec.labels,
						[LABEL.execution]: spec.executionId,
						[LABEL.bead]: spec.beadId,
					},
					...(vault ? { env: secretsEnv(vault.dir) } : {}),
				},
				signal,
			);
			if (signal.aborted) throw new LaunchError("agent stopped");
			if (r.code !== 0)
				throw new LaunchError(agentFailure(r.stderr, "the Paseo agent failed"));
			return parseResult(r.stdout);
		} catch (error) {
			if (error instanceof LaunchError) throw error;
			throw new LaunchError(
				signal.aborted ? "agent stopped" : `paseo: ${paseoMessage(error)}`,
			);
		} finally {
			await p.close();
			if (vault) rmSync(vault.dir, { recursive: true, force: true });
		}
	}
}
