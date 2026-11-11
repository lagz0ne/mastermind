/**
 * The runner's one config file: the service account credential that `enroll`
 * got, and the runner settings. It holds a secret, so it is written with mode
 * 0600, atomically (temp file + rename). A file that does not parse is moved
 * aside, so a broken write never looks like a valid runner.
 *
 * Location: $MASTERMIND_RUNNER_CONFIG, else
 * $XDG_CONFIG_HOME/mastermind/runner.json, else ~/.config/mastermind/runner.json.
 */
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How the runner starts an agent. */
export type AgentSettings = {
	/** Paseo provider, or provider/model (for example `claude`). */
	provider?: string;
	model?: string;
	/** Provider mode, for example `bypassPermissions` for unattended work. */
	mode?: string;
};

export type RunnerSettings = {
	/** Runner id inside the account; claims are held as `<account>/<id>`. */
	id: string;
	/** Queues to take work from. */
	queues: string[];
	/** How many agents may run at the same time; null: unlimited. */
	capacity: number | null;
	/** Capabilities this machine offers (matched against `req:` labels). */
	capabilities: string[];
	/** Agent providers the runner can start. */
	providers: string[];
	/** Where agents work when a dispatch names no repo (absolute path). */
	workdir?: string;
	/** Git remote URL -> local checkout (absolute path). */
	repos: Record<string, string>;
	/** The agent for stage `work`. */
	agent: AgentSettings;
	/** The user's assistant agent, for stages `enrich_input` and `enrich_output`. */
	assistant?: AgentSettings;
	/** Run the shell commands of `env.setup`. Off by default. */
	allowSetup: boolean;
};

export type RunnerConfig = {
	version: 1;
	/** Public origin of Mastermind, for example `https://mastermind.example`. */
	mastermindUrl: string;
	/** NATS WebSocket URL (wss://...) */
	natsUrl: string;
	/** The account (human) that owns this runner. */
	account: string;
	serviceAccount: { id: string; name: string };
	/** Service account credential (`mms_...`). Secret. */
	credential: string;
	/** Reply inbox prefix the service account may subscribe to. */
	inboxPrefix: string;
	/** `revoked` once Mastermind refused the credential. */
	state: "active" | "revoked";
	enrolledAt: string;
	runner: RunnerSettings;
};

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Path of the config file for this environment. */
export function configPath(
	env: Record<string, string | undefined> = process.env,
) {
	if (env.MASTERMIND_RUNNER_CONFIG) return env.MASTERMIND_RUNNER_CONFIG;
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "mastermind", "runner.json");
}

export function defaultSettings(id: string): RunnerSettings {
	return {
		id,
		queues: [],
		capacity: 1,
		capabilities: [],
		providers: ["claude"],
		repos: {},
		agent: {},
		allowSetup: false,
	};
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((s) => typeof s === "string");

/** Throws ConfigError unless `v` is a RunnerConfig. Fills defaults of optional settings. */
export function parseConfig(v: unknown): RunnerConfig {
	const fail = (what: string): never => {
		throw new ConfigError(`config: ${what}`);
	};
	if (!isObj(v) || v.version !== 1) return fail("unknown version");
	for (const k of [
		"mastermindUrl",
		"natsUrl",
		"account",
		"credential",
		"inboxPrefix",
		"enrolledAt",
	] as const) {
		if (typeof v[k] !== "string" || v[k] === "") fail(`${k} is missing`);
	}
	const sa = v.serviceAccount;
	if (!isObj(sa) || typeof sa.id !== "string" || typeof sa.name !== "string")
		fail("serviceAccount is missing");
	if (v.state !== "active" && v.state !== "revoked") fail("bad state");
	const r = v.runner;
	if (!isObj(r) || typeof r.id !== "string") return fail("runner is missing");
	const settings: RunnerSettings = {
		...defaultSettings(r.id),
		...(r as Partial<RunnerSettings>),
	};
	if (!isStrings(settings.queues)) fail("runner.queues must be strings");
	if (!isStrings(settings.capabilities))
		fail("runner.capabilities must be strings");
	if (!isStrings(settings.providers)) fail("runner.providers must be strings");
	if (
		settings.capacity !== null &&
		(!Number.isInteger(settings.capacity) || settings.capacity < 1)
	)
		fail("runner.capacity must be a positive integer or null (unlimited)");
	if (!isObj(settings.repos)) fail("runner.repos must be an object");
	return { ...(v as unknown as RunnerConfig), runner: settings };
}

/**
 * Read the config. Null when there is none. A file that does not parse is
 * renamed to `<path>.corrupt-<time>` and reported as a ConfigError.
 */
export async function loadConfig(path: string): Promise<RunnerConfig | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return parseConfig(JSON.parse(await file.text()));
	} catch (error) {
		const aside = `${path}.corrupt-${Date.now()}`;
		await rename(path, aside).catch(() => {});
		throw new ConfigError(
			`config ${path} is not valid (${error instanceof Error ? error.message : error}); moved to ${aside}, enroll again`,
		);
	}
}

/** Write atomically with mode 0600 (directory 0700). */
export async function saveConfig(
	path: string,
	config: RunnerConfig,
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(config, null, "\t")}\n`, {
		mode: 0o600,
	});
	await chmod(tmp, 0o600);
	await rename(tmp, path);
}

/** File mode bits, for tests and `status`. */
export async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}
