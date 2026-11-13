#!/usr/bin/env bun
/**
 * mastermind-runner: the adapter a user runs on their own machine. It
 * connects to Mastermind over NATS as a service account of the user's account,
 * takes work from queues and runs agents for it through Paseo.
 *
 *   mastermind-runner env init [dir] [--image <ref>] [--secret NAME]... [--network open|host,host]
      [--output pr|branch|none] [--check-cmd <cmd>]... [--post-create <cmd>] [--instructions <text>] [--force]
      writes .devcontainer/devcontainer.json with a customizations.mastermind block
      (asks when a terminal and no flags), merges into an existing file, validates it
  mastermind-runner env test [dir] [--ref <branch>] [--deep] [--json]
      runs the environment like a task, without a task: access check, build,
      box, clone, lifecycle, check, network phases (--deep: a probe agent);
      PASS/FAIL per step with the fix; the box is deleted; nothing is pushed
  mastermind-runner enroll <token> --url <mastermind url> [settings]
 *   mastermind-runner start [settings] [--save]
 *   mastermind-runner check [settings]
 *   mastermind-runner route [dispatch.json] [--env e --queue q --stage s --type t --label l --priority n]
 *   mastermind-runner status [--json]
 *   mastermind-runner doctor [--deep] [--json] [settings]
 *   mastermind-runner secrets [list|set NAME|unset NAME|check] [--json]
 *   mastermind-runner update [--check]
 *   mastermind-runner stop
 *   mastermind-runner --version
 *
 * Settings: --queue <q> (repeat), --capacity <n|unlimited>, --capability <c> (repeat),
 * --providers a,b, --workdir <dir>, --repo <url>=<dir> (repeat), --id <id>,
 * --provider <p>, --model <m>, --mode <m>, --assistant-provider <p>,
 * --allow-setup, --allow-remote-probe (the operator may run doctor --deep remotely), --paseo-host <host>, --routing <file>,
 * --no-auto-update | --auto-update | --pin <version> (start, saved: the supervisor
 * updates the runner when the server is at another version; on by default;
 * supervisor.ts).
 * start: every task runs in a throwaway box (Docker API: DOCKER_HOST or the default socket;
 * --box-image <ref> or MASTERMIND_BOX_IMAGE for environments without an image);
 * --no-box runs agents on this machine instead, at the owner's risk.
 *
 * Environment: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG,
 * MASTERMIND_RUNNER_ROUTING, MASTERMIND_RUNNER_SECRETS.
 */
import { rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { publish, subjects } from "@mastermind/bus";
import {
	DISPATCH_STAGES,
	type Dispatch,
	type DispatchStage,
	type RunnerDiagnostics,
	type RunnerInfo,
} from "@mastermind/core";
import {
	type AccessMap,
	accessStep,
	checkEnvironmentsAccess,
} from "./access.ts";
import { DockerDriver } from "./box/docker.ts";
import { natsBoxFiles } from "./box/files.ts";
import {
	DEFAULT_BOX_IMAGE,
	probeBoxLauncher,
	startBoxMode,
} from "./box/launcher.ts";
import { MODEL_SECRETS } from "./box/proxy.ts";
import { checkRequirement, FileSetupMemory } from "./check.ts";
import {
	checkCredential,
	connectRunner,
	isAuthFailure,
	natsClient,
	RevokedError,
} from "./client.ts";
import {
	ConfigError,
	configPath,
	defaultSettings,
	loadConfig,
	type RunnerConfig,
	type RunnerSettings,
	saveConfig,
} from "./config.ts";
import {
	Diagnostics,
	problems,
	readDoctor,
	runChecks,
	startReporter,
	statusPath,
	writeDoctor,
} from "./diagnostics.ts";
import {
	type DoctorBox,
	type DoctorReport,
	formatReport,
	runDoctor,
} from "./doctor.ts";
import { probeModelSecret } from "./doctor-probe.ts";
import { EnrolError, enrol } from "./enroll.ts";
import {
	EnvInitError,
	type InitOptions,
	initEnvironment,
	parseNetwork,
} from "./env.ts";
import { type EnvTestStep, envTest } from "./env-test.ts";
import { PaseoLauncher, providerLoginMessage } from "./launcher.ts";
import {
	acquireLock,
	LockedError,
	type LockInfo,
	lockPath,
	runningOther,
	stopRunner,
} from "./lock.ts";
import {
	type GateState,
	gatePath,
	readGate,
	recordProbe,
	writeGate,
} from "./login-gate.ts";
import { serveOffers } from "./offer.ts";
import {
	fail,
	type OnboardStep,
	pass,
	runOnboard,
	type StepResult,
} from "./onboard.ts";
import { findEngine, gvisorLine } from "./onboard-box.ts";
import {
	claudeCredential,
	defaultAppName,
	gitCredential,
} from "./onboard-credentials.ts";
import { terminalPrompt } from "./onboard-prompt.ts";
import {
	type BoxCheck,
	evaluate,
	type LoginRefused,
	loginFix,
	loginRefusal,
	RECHECK_MS,
	readinessLine,
	refusalHolds,
	sameReadiness,
} from "./readiness.ts";
import { serveDoctor } from "./remote-doctor.ts";
import {
	decisionLine,
	lintRouting,
	loadRouting,
	type Routing,
	route,
	routingPath,
} from "./routing.ts";
import { Runner } from "./runner.ts";
import { readSecretFromStdin, secretsCommand } from "./secrets/command.ts";
import { lookupSecret } from "./secrets/needs.ts";
import { type SecretsState, secretsState } from "./secrets/state.ts";
import { SecretStore, secretsPath } from "./secrets/store.ts";
import {
	type AutoUpdateMode,
	autoUpdateLine,
	drainWorker,
	type SupervisorState,
	supervise,
} from "./supervisor.ts";
import {
	cannotUpdate,
	installStaged,
	rollbackInstall,
	selfUpdate,
	serverVersion,
	stageUpdate,
	UpdateError,
	updateLine,
	versionWatch,
} from "./update.ts";

/**
 * The Mastermind commit this runner was built from. The api build (apps/api/build.ts)
 * replaces the expression with the server's GIT_SHA; run from source it is "dev".
 */
export const VERSION = process.env.MASTERMIND_RUNNER_VERSION || "dev";

/** Exit codes. */
/** restart: the worker drained for an update; the supervisor starts the new one. */
/** usage is also: `start` while this runner already runs here (mm-210.79). */
/** superseded: a newer process of this runner started (here or elsewhere). */
export const EXIT = {
	ok: 0,
	error: 1,
	usage: 2,
	revoked: 3,
	superseded: 4,
	restart: 75,
} as const;

const OPTIONS = {
	url: { type: "string" },
	"nats-url": { type: "string" },
	id: { type: "string" },
	queue: { type: "string", multiple: true },
	capacity: { type: "string" },
	capability: { type: "string", multiple: true },
	providers: { type: "string" },
	workdir: { type: "string" },
	repo: { type: "string", multiple: true },
	provider: { type: "string" },
	model: { type: "string" },
	mode: { type: "string" },
	"assistant-provider": { type: "string" },
	"allow-setup": { type: "boolean" },
	"allow-remote-probe": { type: "boolean" },
	"auto-update": { type: "boolean" },
	"no-auto-update": { type: "boolean" },
	pin: { type: "string" },
	check: { type: "boolean" },
	"paseo-host": { type: "string" },
	"no-box": { type: "boolean" },
	"no-paseo-link": { type: "boolean" },
	"box-image": { type: "string" },
	routing: { type: "string" },
	env: { type: "string" },
	stage: { type: "string" },
	type: { type: "string" },
	label: { type: "string", multiple: true },
	priority: { type: "string" },
	save: { type: "boolean" },
	force: { type: "boolean" },
	deep: { type: "boolean" },
	start: { type: "boolean" },
	claude: { type: "string" },
	git: { type: "string" },
	"github-org": { type: "string" },
	"github-app-name": { type: "string" },
	"github-app-id": { type: "string" },
	"github-app-key": { type: "string" },
	"non-interactive": { type: "boolean" },
	"no-browser": { type: "boolean" },
	image: { type: "string" },
	secret: { type: "string", multiple: true },
	network: { type: "string" },
	output: { type: "string" },
	"check-cmd": { type: "string", multiple: true },
	"post-create": { type: "string" },
	instructions: { type: "string" },
	ref: { type: "string" },
	json: { type: "boolean" },
	version: { type: "boolean", short: "v" },
	help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<
	typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

export class UsageError extends Error {
	override name = "UsageError";
}

const USAGE = `usage:
  mastermind-runner onboard [<token>] --url <mastermind url> [settings] [--no-box] [--start]
      checks this machine (box engine: found by itself or the install link;
      Paseo, providers, box image), enrols, sets up the credentials on this
      machine only (Claude, git), asks for missing secrets, runs doctor --deep,
      then marks the runner READY; stops at the first failure with the fix;
      run it again after the fix (what is done is kept). Guide: SETUP.md.
      --start: start the runner when it is READY
      --claude setup-token|api-key|skip   --git app|token|skip (values from stdin)
      --github-org <org> --github-app-name <name> (the app the manifest makes)
      --github-app-id <id> --github-app-key <file.pem> (an app made before)
      --non-interactive (flags and stdin only) --no-browser --json
  mastermind-runner enroll <token> --url <mastermind url> [settings]
      enrol only: the runner stays NOT READY (no work) until onboard passes
  mastermind-runner start [settings] [--save] [--box-image <ref>] [--no-box] [--no-paseo-link]
      every task runs in a throwaway box (Docker or Podman API: DOCKER_HOST);
      --no-box: agents run on this machine, at your own risk (the ticket says so)
      each box shows as host 'mastermind:<item>' in this machine's Paseo app;
      --no-paseo-link (or MASTERMIND_PASEO_LINK=0): not
  mastermind-runner check [settings]
  mastermind-runner route [dispatch.json] [--env <name>] [--queue <q>]
      [--stage work] [--type <t>] [--label <l>]... [--priority <n>]
  mastermind-runner status [--json]
  mastermind-runner doctor [--deep] [--json] [--box-image <ref>] [--no-box] [settings]
      steps a-d: config, NATS, routing, Paseo; --deep: e. a real agent; f. secrets;
      g. box engine and default image (--deep: a real box); --no-box skips g
  mastermind-runner secrets [list] [--json]   needed, present, missing (names only)
  mastermind-runner secrets set <NAME>        value from stdin or a hidden prompt
  mastermind-runner secrets unset <NAME>
  mastermind-runner secrets check             exit 1 when a needed one is missing
  mastermind-runner update [--check]
      downloads the runner of the server's version (sha256 checked) and
      replaces this executable; --check only reports
  mastermind-runner stop
      ends the runner that runs with this config (by its PID in runner.pid;
      it gives its work back first); one runner per config: a second start
      exits 2 with that PID
  mastermind-runner --version

settings: --queue <q>... --capacity <n|unlimited> --capability <c>... --providers a,b
  --workdir <dir> --repo <url>=<dir>... --id <id> --provider <p> --model <m>
  --mode <m> --assistant-provider <p> --allow-setup --allow-remote-probe --paseo-host <host>
  --routing <file> (default: routing.json next to the config)
  start runs a supervisor and one worker process; the supervisor restarts a
  crashed worker (1 s, 5 s, 30 s, then every 5 min) and updates the runner:
  when the server is at another version the worker takes no new work, its
  running tasks finish, then the new version runs (a new version that crashes
  3 times in 10 min is rolled back). Auto-update is ON by default:
  --no-auto-update turns it off, --pin <version> updates only to that
  version, --auto-update turns it on again (saved in the config)
env: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG,
  MASTERMIND_RUNNER_ROUTING, MASTERMIND_RUNNER_SECRETS`;

/** Settings with the command-line flags applied. */
export function applyFlags(
	base: RunnerSettings,
	f: Flags,
	cwd = process.cwd(),
): RunnerSettings {
	const s: RunnerSettings = {
		...base,
		repos: { ...base.repos },
		agent: { ...base.agent },
	};
	if (f.id) s.id = f.id;
	if (f.queue?.length) s.queues = f.queue;
	if (f.capacity !== undefined) s.capacity = parseCapacity(f.capacity);
	if (f.capability?.length) s.capabilities = f.capability;
	if (f.providers)
		s.providers = f.providers
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
	if (f.workdir) s.workdir = resolve(cwd, f.workdir);
	for (const r of f.repo ?? []) {
		const i = r.lastIndexOf("=");
		if (i <= 0) throw new UsageError(`--repo wants <url>=<dir>: ${r}`);
		s.repos[r.slice(0, i)] = resolve(cwd, r.slice(i + 1));
	}
	if (f.provider) s.agent.provider = f.provider;
	if (f.model) s.agent.model = f.model;
	if (f.mode) s.agent.mode = f.mode;
	if (f["assistant-provider"])
		s.assistant = { ...s.assistant, provider: f["assistant-provider"] };
	if (f["allow-setup"]) s.allowSetup = true;
	if (f["allow-remote-probe"]) s.allowRemoteProbe = true;
	if (f["auto-update"]) {
		s.autoUpdate = true;
		delete s.pin;
	}
	if (f.pin) {
		s.autoUpdate = true;
		s.pin = f.pin;
	}
	if (f["no-auto-update"]) s.autoUpdate = false;
	if (s.workdir && !isAbsolute(s.workdir))
		throw new UsageError("workdir must be absolute");
	return s;
}

/** `--capacity`: a positive integer, or "unlimited" (0 is the same): null. */
export function parseCapacity(v: string): number | null {
	if (v === "unlimited" || v === "0") return null;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1)
		throw new UsageError("--capacity must be a positive integer or unlimited");
	return n;
}

export function capacityText(capacity: number | null): string {
	return capacity === null ? "unlimited" : String(capacity);
}

export function runnerInfo(
	cfg: RunnerConfig,
	s: RunnerSettings,
	routing?: Routing,
): RunnerInfo {
	return {
		id: s.id,
		account: cfg.account,
		serviceAccount: cfg.serviceAccount.id,
		capabilities: s.capabilities,
		capacity: s.capacity,
		queues: s.queues,
		version: VERSION,
		...(routing && !routing.implicit
			? { environments: Object.keys(routing.environments) }
			: {}),
	};
}

async function routingFor(path: string, s: RunnerSettings, f: Flags, io: Io) {
	return loadRouting(
		f.routing ? resolve(io.cwd, f.routing) : routingPath(path, io.env),
		s,
		f["paseo-host"],
	);
}

/** A dispatch for `route`: from a JSON file, then the flags on top. */
async function sampleDispatch(
	file: string | undefined,
	f: Flags,
	io: Io,
): Promise<Dispatch> {
	let d: Partial<Dispatch> = {};
	if (file) {
		try {
			d = JSON.parse(await Bun.file(resolve(io.cwd, file)).text());
		} catch (error) {
			throw new UsageError(`cannot read dispatch ${file}: ${error}`);
		}
	}
	const bead = {
		id: "dry-run",
		title: "dry run",
		status: "open",
		priority: 2,
		type: "task",
		labels: [],
		blocked: false,
		createdAt: "",
		updatedAt: "",
		...d.bead,
	} as Dispatch["bead"];
	const env = { repo: "", ref: "", requires: [], ...d.env };
	if (f.env) env.name = f.env;
	if (f.type) bead.type = f.type;
	if (f.label?.length) bead.labels = [...bead.labels, ...f.label];
	if (f.priority !== undefined) {
		const n = Number(f.priority);
		if (!Number.isInteger(n))
			throw new UsageError("--priority must be an integer");
		bead.priority = n as Dispatch["bead"]["priority"];
	}
	const stage = (f.stage ?? d.stage ?? "work") as DispatchStage;
	if (!DISPATCH_STAGES.includes(stage))
		throw new UsageError(
			`--stage must be one of ${DISPATCH_STAGES.join(", ")}`,
		);
	const queue = f.queue?.[0] ?? d.queue;
	if (!queue)
		throw new UsageError("route needs --queue or a dispatch with a queue");
	return {
		actor: "",
		lease: { expiresAt: "", heartbeatAt: "" },
		prompt: "",
		...d,
		bead,
		env,
		stage,
		queue,
	} as Dispatch;
}

/** The config without its secret, for printing. */
export function redact(cfg: RunnerConfig) {
	return { ...cfg, credential: `${cfg.credential.slice(0, 8)}…` };
}

type Io = {
	env: Record<string, string | undefined>;
	out: (line: string) => void;
	err: (line: string) => void;
	cwd: string;
	/** `secrets set`: read the value (default: stdin, or a hidden prompt). */
	readSecret?: (prompt: string) => Promise<string>;
	/** For the Mastermind HTTP calls (tests). */
	fetch?: typeof fetch;
	/** onboard: one visible line (tests; default: the terminal). */
	ask?: (prompt: string, signal?: AbortSignal) => Promise<string>;
	/** onboard: may it ask (default: stdin is a terminal)? */
	interactive?: boolean;
	/** update: the executable to replace (tests; default: process.execPath). */
	exe?: string;
	/** update: `<exe> --version` of the new binary (tests). */
	runVersion?: (exe: string) => Promise<string>;
};

/** The secrets state of this runner: needed names from Mastermind, values looked up locally. */
async function secretsFor(
	cfg: RunnerConfig | null,
	routing: Routing,
	io: Io,
): Promise<SecretsState> {
	return secretsState({
		file: secretsPath(io.env),
		...(cfg && cfg.state === "active"
			? {
					mastermindUrl: io.env.MASTERMIND_URL ?? cfg.mastermindUrl,
					credential: cfg.credential,
				}
			: {}),
		routing,
		env: io.env,
		fetch: io.fetch,
	});
}

/** Git access of each environment this runner may be offered (readiness, onboard: access.ts). */
async function accessFor(
	state: SecretsState,
	routing: Routing,
	io: Io,
): Promise<AccessMap> {
	return checkEnvironmentsAccess({
		needs: state.needs,
		routing,
		store: await new SecretStore(secretsPath(io.env)).load().catch(() => ({})),
		env: io.env,
	});
}

const stamp = () => new Date().toISOString();

async function requireConfig(path: string): Promise<RunnerConfig> {
	const cfg = await loadConfig(path);
	if (!cfg) throw new UsageError(`not enrolled (no ${path}); run enroll first`);
	if (cfg.state === "revoked")
		throw new RevokedError("this runner was revoked; enroll again");
	return cfg;
}

/**
 * The worker's arguments for `<cmd> ... --start` (onboard): `start` with the
 * same flags, without the command's positional (an enrol token).
 */
export function workerArgv(
	argv: string[],
	cmd: string,
	positional?: string,
): string[] {
	const out = [...argv];
	const i = out.indexOf(cmd);
	if (i >= 0) out.splice(i, 1);
	if (positional !== undefined) {
		const j = out.indexOf(positional);
		if (j >= 0) out.splice(j, 1);
	}
	return ["start", ...out.filter((a) => a !== "--start")];
}

export async function main(argv: string[], io: Io): Promise<number> {
	let parsed: ReturnType<
		typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
	>;
	try {
		parsed = parseArgs({
			args: argv,
			options: OPTIONS,
			allowPositionals: true,
		});
	} catch (error) {
		io.err(`${error instanceof Error ? error.message : error}\n${USAGE}`);
		return EXIT.usage;
	}
	const { values: f, positionals } = parsed;
	const [cmd, ...rest] = positionals;
	if (f.version || cmd === "version") {
		io.out(VERSION);
		return EXIT.ok;
	}
	if (f.help || !cmd) {
		io.out(USAGE);
		return f.help ? EXIT.ok : EXIT.usage;
	}
	const path = configPath(io.env);
	try {
		switch (cmd) {
			case "onboard":
				return await cmdOnboard(
					path,
					rest[0],
					f,
					io,
					workerArgv(argv, cmd, rest[0]),
				);
			case "enroll":
			case "enrol":
				return await cmdEnroll(path, rest[0], f, io);
			case "start":
				return await cmdStart(path, f, io, argv);
			case "check":
				return await cmdCheck(path, f, io);
			case "route":
				return await cmdRoute(path, rest[0], f, io);
			case "status":
				return await cmdStatus(path, f, io);
			case "doctor":
				return await cmdDoctor(path, f, io);
			case "secrets":
			case "secret":
				return await cmdSecrets(path, rest, f, io);
			case "env":
				return await cmdEnv(path, rest, f, io);
			case "update":
				return await cmdUpdate(path, f, io);
			case "stop":
				return await cmdStop(path, io);
			default:
				throw new UsageError(`unknown command ${cmd}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`${error.message}\n${USAGE}`);
			return EXIT.usage;
		}
		if (error instanceof RevokedError) {
			io.err(error.message);
			return EXIT.revoked;
		}
		if (
			error instanceof ConfigError ||
			error instanceof EnrolError ||
			error instanceof EnvInitError ||
			error instanceof UpdateError
		) {
			io.err(error.message);
			return EXIT.error;
		}
		throw error;
	}
}

/** A runner process still runs with this config: what to do. */
function stillRunsLine(l: LockInfo, what: string): string {
	return `runner ${l.runner} still runs here (PID ${l.pid}, started ${l.startedAt}${l.version ? `, version ${l.version}` : ""}); it uses ${what} only after a restart: mastermind-runner stop, then mastermind-runner start`;
}

/** `stop`: end the runner of this config by its PID (lock.ts). */
async function cmdStop(path: string, io: Io): Promise<number> {
	const r = await stopRunner(lockPath(path));
	if (r.kind === "not-running") {
		io.out("no runner runs with this config");
		return EXIT.ok;
	}
	const who = `runner ${r.holder.runner} (PID ${r.holder.pid})`;
	if (r.kind === "stopped") {
		io.out(`${who} stopped`);
		return EXIT.ok;
	}
	io.err(
		`${who} still runs after 60 s (it gives work back first); try again, or: kill ${r.holder.pid}`,
	);
	return EXIT.error;
}

/** A status.json older than this: the runner is probably not running. */
const STALE_MS = 60_000;

async function readStatus(path: string): Promise<RunnerDiagnostics | null> {
	try {
		return (await Bun.file(statusPath(path)).json()) as RunnerDiagnostics;
	} catch {
		return null;
	}
}

/** `update [--check]`: the runner of the server's version replaces this one (update.ts). */
async function cmdUpdate(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await loadConfig(path).catch(() => null);
	const url = f.url ?? io.env.MASTERMIND_URL ?? cfg?.mastermindUrl;
	if (!url)
		throw new UsageError("update needs --url <mastermind url> (not enrolled)");
	const r = await selfUpdate({
		url,
		version: VERSION,
		check: f.check === true,
		fetch: io.fetch,
		...(io.exe ? { exe: io.exe } : {}),
		...(io.runVersion ? { runVersion: io.runVersion } : {}),
	});
	io.out(updateLine(r));
	if (r.state === "updated") {
		const other = await runningOther(lockPath(path));
		if (other) io.out(stillRunsLine(other, "the new version"));
	}
	return EXIT.ok;
}

/** The config and the last status the running runner wrote. */
async function cmdStatus(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await loadConfig(path);
	const status = await readStatus(path);
	const age = status ? Date.now() - Date.parse(status.at) : null;
	const stale = age === null || Number.isNaN(age) || age > STALE_MS;
	if (f.json) {
		io.out(
			JSON.stringify(
				{
					path,
					config: cfg ? redact(cfg) : null,
					diagnostics: status,
					stale,
				},
				null,
				2,
			),
		);
		return cfg ? EXIT.ok : EXIT.error;
	}
	if (!cfg) {
		io.out(`not enrolled (${path})`);
		return EXIT.error;
	}
	io.out(
		`runner ${cfg.account}/${cfg.runner.id} (${cfg.state}), config ${path}`,
	);
	if (!status) {
		io.out("no status yet: the runner has not run (mastermind-runner start)");
		return EXIT.ok;
	}
	const d = status;
	io.out(
		`status at ${d.at}${stale ? " (STALE: is the runner running?)" : ""}: ${d.state}, nats ${d.natsServer ?? "-"}, reconnects ${d.reconnects}, version ${d.version}`,
	);
	io.out(
		`queues ${d.queues.join(",") || "-"}, running ${d.running}/${capacityText(d.capacity)}, last next ${d.lastNextResult ?? "-"} at ${d.lastNextAt ?? "-"}`,
	);
	if (d.lastDecision) io.out(`last decision: ${d.lastDecision}`);
	for (const x of d.inFlight)
		io.out(
			`  ${x.itemId} ${x.queue}/${x.stage} target ${x.target ?? "-"} since ${x.startedAt}`,
		);
	const c = d.checks;
	const mark = (v: boolean | null) => (v === null ? "?" : v ? "✓" : "✗");
	io.out(
		`checks at ${c.checkedAt ?? "-"}: paseo ${mark(c.paseo)}, workdir ${mark(c.workdir)}, providers ${
			Object.entries(c.providers)
				.map(([p, ok]) => `${p} ${mark(ok)}`)
				.join(", ") || "-"
		}`,
	);
	const update = (d as { update?: string }).update;
	if (update) io.out(`warning: ${update}`);
	io.out(
		(d as { autoUpdate?: string }).autoUpdate ??
			`auto-update: ${configModeLine(cfg.runner)}`,
	);
	const sec = (d as { secrets?: SecretsState["diagnostics"] }).secrets;
	if (sec)
		io.out(
			`secrets: ${sec.needed.length} needed, ${sec.missing.length ? `MISSING ${sec.missing.join(", ")} (fix: mastermind-runner secrets set <NAME>)` : "none missing"}${sec.problem ? ` (${sec.problem})` : ""}`,
		);
	if (d.lastErrors.length) {
		io.out("last errors:");
		for (const l of d.lastErrors) io.out(`  ${l}`);
	}
	return EXIT.ok;
}

/**
 * Test the path a dispatch takes (doctor.ts): a. config, b. NATS, c. routing,
 * d. Paseo, and with --deep e. a real agent. Exit 1 when a step fails.
 */
/** What the doctor needs, for a local and for a remote run. */
function doctorInput(
	path: string,
	cfg: RunnerConfig | null,
	s: RunnerSettings,
	routing: Routing,
	source: string,
	io: Io,
	box: DoctorBox,
) {
	return {
		config: cfg,
		configPath: path,
		settings: s,
		routing,
		routingSource: source,
		mastermindUrl: io.env.MASTERMIND_URL ?? cfg?.mastermindUrl,
		natsUrl: io.env.MASTERMIND_NATS_URL ?? cfg?.natsUrl,
		version: VERSION,
		secrets: () => secretsFor(cfg, routing, io),
		box,
		// Step e in box mode: the model credential a box gets (mm-210.82).
		modelSecret: () => modelFor(io),
	};
}

/** The model credential a box gets: store, else env (never printed). */
async function modelFor(io: Io) {
	return probeModelSecret({
		store: await new SecretStore(secretsPath(io.env)).load().catch(() => ({})),
		env: io.env,
	});
}

/** The default image of box mode: --box-image, else MASTERMIND_BOX_IMAGE, else the default. */
function boxImage(f: Flags, io: Io): string {
	return f["box-image"] || io.env.MASTERMIND_BOX_IMAGE || DEFAULT_BOX_IMAGE;
}

/**
 * Steps e and g of a local doctor: box mode unless --no-box. The probe agent
 * of --deep runs in a box over the same Paseo control as a task (mm-210.82).
 */
async function doctorBox(
	f: Flags,
	io: Io,
	runnerId: string,
	driver: DockerDriver = new DockerDriver({ env: io.env }),
): Promise<DoctorBox> {
	if (f["no-box"]) return { noBox: true };
	const image = boxImage(f, io);
	const probe = await probeBoxLauncher({
		runnerId,
		env: io.env,
		image,
		log: () => {},
	}).catch(() => undefined);
	return { driver, image, ...(probe ? { probe } : {}) };
}

async function cmdDoctor(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await loadConfig(path);
	const s = applyFlags(
		cfg?.runner ?? defaultSettings("not-enrolled"),
		f,
		io.cwd,
	);
	const { routing, source } = await routingFor(path, s, f, io);
	const runnerProblems: { problem: string; fix: string }[] = [];
	const status = cfg ? await readStatus(path) : null;
	if (status) {
		const age = Date.now() - Date.parse(status.at);
		if (!(age <= STALE_MS))
			runnerProblems.push({
				problem: `the runner is not running (last status ${status.at})`,
				fix: "mastermind-runner start",
			});
		else if (status.state !== "connected")
			runnerProblems.push({
				problem: `the running runner is ${status.state} to NATS`,
				fix: "check the network; the runner keeps retrying",
			});
		else if (status.lastNextResult === "error")
			runnerProblems.push({
				problem: "the last next request failed (no member rights on a queue?)",
				fix: "see the last errors in: mastermind-runner status; ask the queue owner to add this account",
			});
	}
	const report = await runDoctor({
		...doctorInput(
			path,
			cfg,
			s,
			routing,
			source,
			io,
			await doctorBox(f, io, s.id),
		),
		deep: f.deep === true,
		runnerProblems,
	});
	// The running runner sends it to Mastermind as lastDoctor.
	if (cfg) await writeDoctor(path, report).catch(() => {});
	// The box probe's answer sets or lifts the login gate of a running runner (mm-210.81).
	if (cfg && !f["no-box"])
		await recordProbe(path, report, await modelFor(io), MODEL_SECRETS).catch(
			() => null,
		);
	if (f.json) io.out(JSON.stringify(report, null, 2));
	else for (const l of formatReport(report)) io.out(l);
	return report.ok ? EXIT.ok : EXIT.error;
}

/** `secrets [list|set|unset|check]`: names and presence only, never a value. */
async function cmdSecrets(
	path: string,
	args: string[],
	f: Flags,
	io: Io,
): Promise<number> {
	const cfg = await loadConfig(path);
	const s = applyFlags(
		cfg?.runner ?? defaultSettings("not-enrolled"),
		f,
		io.cwd,
	);
	return secretsCommand(args, {
		file: secretsPath(io.env),
		json: f.json === true,
		state: async () =>
			secretsFor(cfg, (await routingFor(path, s, f, io)).routing, io),
		io,
	});
}

async function cmdEnroll(
	path: string,
	token: string | undefined,
	f: Flags,
	io: Io,
): Promise<number> {
	if (!token) throw new UsageError("enroll needs the enrol token");
	const url = f.url ?? io.env.MASTERMIND_URL;
	if (!url) throw new UsageError("pass --url or set MASTERMIND_URL");
	const existing = await loadConfig(path).catch(() => null);
	if (existing?.state === "active" && !f.force)
		throw new UsageError(
			`already enrolled as ${existing.account}/${existing.runner.id}; pass --force to replace`,
		);
	const cfg = await enrol({
		mastermindUrl: url,
		token,
		natsUrl: f["nats-url"] ?? io.env.MASTERMIND_NATS_URL,
	});
	cfg.runner = applyFlags(cfg.runner, f, io.cwd);
	await saveConfig(path, cfg);
	io.out(
		`enrolled: account ${cfg.account}, service account ${cfg.serviceAccount.name} (${cfg.serviceAccount.id}), runner ${cfg.runner.id}\nconfig: ${path}`,
	);
	return EXIT.ok;
}

/** The steps of `onboard` (onboard.ts), wired to this machine. */
async function cmdOnboard(
	path: string,
	token: string | undefined,
	f: Flags,
	io: Io,
	startArgv: string[],
): Promise<number> {
	let cfg = await loadConfig(path).catch(() => null);
	if (cfg?.state === "revoked") cfg = null;
	let settings = applyFlags(
		cfg?.runner ?? defaultSettings("not-enrolled"),
		f,
		io.cwd,
	);
	const noBox = f["no-box"] === true;
	// Made by the engine step, on the socket it found.
	let driver: DockerDriver | null = null;
	const say = f.json ? io.err : io.out;
	const prompt = terminalPrompt({
		out: say,
		interactive:
			!f["non-interactive"] && (io.interactive ?? process.stdin.isTTY === true),
		...(io.ask ? { ask: io.ask } : {}),
		readSecret: io.readSecret ?? readSecretFromStdin,
		noBrowser: f["no-browser"] === true,
	});
	const steps: OnboardStep[] = [];
	if (!noBox)
		steps.push({
			name: "box engine",
			run: async () => {
				const e = await findEngine({ env: io.env });
				if (!e.ok) return fail(e.problem, e.fix);
				driver = new DockerDriver({ env: e.env });
				return pass(
					`${e.version} at ${e.endpoint.label}; ${gvisorLine(e.runtimes)}${e.exportLine ? `; for start: ${e.exportLine}` : ""}`,
				);
			},
		});
	steps.push({
		name: "Paseo and providers",
		run: async () => {
			const c = await runChecks(settings, {
				paseoHost: f["paseo-host"],
				login: noBox,
			});
			const p = problems(c, settings).find((x) => x.problem !== "no queues");
			if (p) return fail(p.problem, p.fix);
			return pass(
				`daemon answers; providers ${Object.keys(c.providers).join(", ") || "-"} available`,
			);
		},
	});
	if (!noBox)
		steps.push({
			name: "default box image",
			run: async () => {
				const image = boxImage(f, io);
				if (!driver) return fail("no box engine", "run onboard again");
				try {
					return pass(await driver.ensureImage({ image }));
				} catch (error) {
					return fail(
						`cannot pull ${image}: ${error instanceof Error ? error.message : error}`,
						"check the network and the registry; or set another image: --box-image <ref>",
					);
				}
			},
		});
	steps.push({
		name: "enroll",
		run: async () => {
			if (cfg?.state === "active" && !f.force) {
				settings = applyFlags(cfg.runner, f, io.cwd);
				cfg = { ...cfg, runner: settings };
				await saveConfig(path, cfg);
				return pass(
					`already enrolled as ${cfg.account}/${settings.id} (the token is not used; --force enrols again)`,
				);
			}
			if (!token)
				return fail(
					"not enrolled and no enrol token",
					"get a token on /people (Add runner), then: mastermind-runner onboard <token> --url <mastermind url>",
				);
			const url = f.url ?? io.env.MASTERMIND_URL;
			if (!url)
				return fail("no Mastermind URL", "pass --url or set MASTERMIND_URL");
			const fresh = await enrol({
				mastermindUrl: url,
				token,
				natsUrl: f["nats-url"] ?? io.env.MASTERMIND_NATS_URL,
			});
			settings = applyFlags(fresh.runner, f, io.cwd);
			cfg = { ...fresh, runner: settings };
			await saveConfig(path, cfg);
			return pass(
				`account ${cfg.account}, service account ${cfg.serviceAccount.name}, runner ${settings.id}; config ${path}`,
			);
		},
	});
	steps.push({
		name: "queues",
		run: async () =>
			settings.queues.length
				? pass(settings.queues.join(", "))
				: fail("no queues", "run onboard again with --queue <q>"),
	});
	// Credentials: values only in the local secret store (onboard-credentials.ts).
	const store = new SecretStore(secretsPath(io.env));
	steps.push({
		name: "Claude login",
		run: () =>
			claudeCredential({
				store,
				prompt,
				...(f.claude ? { choice: f.claude } : {}),
				...(io.fetch ? { fetch: io.fetch } : {}),
			}),
	});
	steps.push({
		name: "git credential",
		run: async () => {
			let appKey: string | undefined;
			if (f["github-app-key"]) {
				const file = Bun.file(resolve(io.cwd, f["github-app-key"]));
				if (!(await file.exists()))
					return fail(
						`no file ${f["github-app-key"]}`,
						"--github-app-key <the app's private key .pem>",
					);
				appKey = await file.text();
			}
			return gitCredential({
				store,
				prompt,
				appName:
					f["github-app-name"] ??
					defaultAppName(cfg?.account ?? "runner", settings.id),
				...(f.git ? { choice: f.git } : {}),
				...(f["github-org"] ? { org: f["github-org"] } : {}),
				...(f["github-app-id"] ? { appId: f["github-app-id"] } : {}),
				...(appKey ? { appKey } : {}),
				...(io.fetch ? { fetch: io.fetch } : {}),
			});
		},
	});
	let routing: Routing | null = null;
	let source = "";
	steps.push({
		name: "secrets",
		run: async () => {
			({ routing, source } = await routingFor(path, settings, f, io));
			const r = routing;
			let state = await secretsFor(cfg, r, io);
			if (!state.needs)
				return fail(
					state.problem ?? "the needed secrets are unknown",
					"check the connection to Mastermind, then run onboard again",
				);
			for (const name of state.diagnostics.missing) {
				const value = await (io.readSecret ?? readSecretFromStdin)(
					`secret ${name} is needed; value (hidden): `,
				);
				if (!value)
					return fail(
						`no value for ${name}`,
						`mastermind-runner secrets set ${name}, then run onboard again`,
					);
				await store.set(name, value);
			}
			state = await secretsFor(cfg, r, io);
			if (state.diagnostics.missing.length)
				return fail(
					`missing secrets: ${state.diagnostics.missing.join(", ")}`,
					state.diagnostics.missing
						.map((m) => `mastermind-runner secrets set ${m}`)
						.join("; "),
				);
			return pass(
				state.diagnostics.needed.length
					? `${state.diagnostics.needed.join(", ")} present`
					: "none needed",
			);
		},
	});
	steps.push({
		name: "git access",
		run: async () => {
			const r = routing as unknown as Routing;
			return accessStep(await accessFor(await secretsFor(cfg, r, io), r, io));
		},
	});
	steps.push({
		name: "doctor --deep",
		run: async () => {
			const report = await runDoctor({
				...doctorInput(
					path,
					cfg,
					settings,
					routing as unknown as Routing,
					source,
					io,
					driver
						? await doctorBox(f, io, settings.id, driver)
						: { noBox: true },
				),
				deep: true,
			});
			await writeDoctor(path, report).catch(() => {});
			if (driver)
				await recordProbe(
					path,
					report,
					await modelFor(io),
					MODEL_SECRETS,
				).catch(() => null);
			const bad = report.steps.find((s) => s.status === "fail");
			if (!bad) return pass(`${report.steps.length} steps pass`);
			for (const l of formatReport(report)) io.out(`  ${l}`);
			return fail(
				`${bad.id}. ${bad.name}: ${bad.problem ?? "failed"}`,
				bad.fix ?? "see the doctor report above",
			);
		},
	});
	steps.push({
		name: "ready",
		run: async () => {
			if (!cfg) return fail("not enrolled", "run onboard with a token");
			cfg = { ...cfg, runner: settings, onboardedAt: stamp() };
			await saveConfig(path, cfg);
			return pass(`runner ${cfg.account}/${settings.id} is READY`);
		},
	});
	const results: ({ name: string } & StepResult)[] = [];
	const ok = await runOnboard(steps, say, (name, r) =>
		results.push({ name, ...r }),
	);
	if (f.json) io.out(JSON.stringify({ ready: ok, steps: results }, null, 2));
	if (!ok) return EXIT.error;
	const other = await runningOther(lockPath(path));
	if (other) say(stillRunsLine(other, "this onboarding"));
	if (f.start) return cmdStart(path, f, io, startArgv);
	say("start it: mastermind-runner start");
	return EXIT.ok;
}

const OUTPUTS = ["pr", "branch", "none"];

/** `env init [dir]` and `env test [dir]` (env.ts, env-test.ts). */
async function cmdEnv(
	path: string,
	args: string[],
	f: Flags,
	io: Io,
): Promise<number> {
	const [sub, target] = args;
	const dir = resolve(io.cwd, target ?? ".");
	const interactive =
		!f["non-interactive"] && (io.interactive ?? process.stdin.isTTY === true);
	const say = f.json ? io.err : io.out;
	if (sub === "init") {
		const o: InitOptions = { force: f.force === true };
		if (f.image) o.image = f.image;
		if (f.secret?.length) o.secrets = f.secret;
		if (f.network) o.network = parseNetwork(f.network);
		if (f.output) {
			if (!OUTPUTS.includes(f.output))
				throw new UsageError("--output must be pr, branch or none");
			o.output = f.output as InitOptions["output"];
		}
		if (f["check-cmd"]?.length) o.check = f["check-cmd"];
		if (f["post-create"]) o.postCreate = f["post-create"];
		if (f.instructions) o.instructions = f.instructions;
		const given = [f.image, f.secret, f.network, f.output, f["check-cmd"]].some(
			(x) => x !== undefined,
		);
		if (interactive && !given) {
			const ask = terminalPrompt({
				out: say,
				interactive,
				...(io.ask ? { ask: io.ask } : {}),
				readSecret: io.readSecret ?? readSecretFromStdin,
			}).line;
			const image = (
				await ask("base image (Enter: keep or the default): ")
			).trim();
			if (image) o.image = image;
			const secrets = (
				await ask("secret names the box needs, comma separated (Enter: none): ")
			)
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean);
			if (secrets.length) o.secrets = secrets;
			const net = (
				await ask(
					"network: open, or the hosts the agent may reach (Enter: open): ",
				)
			).trim();
			if (net) o.network = parseNetwork(net);
			const out = (
				await ask("output: pr, branch or none (Enter: pr): ")
			).trim();
			if (out) {
				if (!OUTPUTS.includes(out))
					throw new UsageError("output must be pr, branch or none");
				o.output = out as InitOptions["output"];
			}
		}
		const r = await initEnvironment(dir, o);
		if (f.json) io.out(JSON.stringify(r, null, 2));
		else {
			io.out(`${r.action}: ${r.path}`);
			for (const w of r.validation.warnings) io.out(`  note: ${w}`);
			for (const e of r.validation.errors) io.out(`  ✗ ${e}`);
			if (r.validation.ok)
				io.out(
					`valid. Test it (it uses this file from your disk): mastermind-runner env test ${target ?? "."}; then commit and push it`,
				);
		}
		return r.validation.ok ? EXIT.ok : EXIT.error;
	}
	if (sub === "test") {
		if (!(await dirExists(dir)))
			throw new UsageError(
				`env test takes a repo directory; ${target} is not one (an environment by name: not yet)`,
			);
		const cfg = await loadConfig(path).catch(() => null);
		const s = applyFlags(cfg?.runner ?? defaultSettings("env-test"), f, io.cwd);
		const steps: EnvTestStep[] = [];
		const emit = (x: EnvTestStep) => {
			steps.push(x);
			say(`${x.ok ? "PASS" : "FAIL"} ${x.step}: ${x.detail}`);
			if (x.fix) say(`  fix: ${x.fix}`);
		};
		let ok = false;
		const engine = await findEngine({ env: io.env });
		if (!engine.ok)
			emit({
				step: "box engine",
				ok: false,
				detail: engine.problem,
				fix: engine.fix,
			});
		else
			ok = await envTest({
				dir,
				...(f.ref ? { ref: f.ref } : {}),
				deep: f.deep === true,
				agent: s.agent,
				defaultImage: boxImage(f, io),
				env: engine.env,
				loadSecrets: () => new SecretStore(secretsPath(io.env)).load(),
				driver: new DockerDriver({ env: engine.env }),
				emit,
			});
		if (f.json) io.out(JSON.stringify({ ok, steps }, null, 2));
		else say(ok ? "env test PASS" : "env test FAIL");
		return ok ? EXIT.ok : EXIT.error;
	}
	throw new UsageError("env init [dir] | env test [dir]");
}

async function dirExists(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function cmdCheck(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await requireConfig(path);
	const s = applyFlags(cfg.runner, f, io.cwd);
	let bad = 0;
	for (const c of s.capabilities) {
		const why = await checkRequirement(c, s);
		if (why) bad++;
		io.out(`${why ? "✗" : "✓"} ${why ?? c}`);
	}
	if (!s.queues.length) {
		bad++;
		io.out("✗ no queues (--queue)");
	}
	const { routing, source } = await routingFor(path, s, f, io);
	const problems = lintRouting(routing, s);
	for (const p of problems) io.out(`✗ ${p}`);
	bad += problems.length;
	if (routing.implicit && !s.workdir && !Object.keys(s.repos).length) {
		bad++;
		io.out("✗ no workdir and no repos (--workdir, --repo)");
	}
	io.out(
		`routing ${source}: ${Object.keys(routing.targets).length} targets, ${routing.rules.length} rules, environments ${Object.keys(routing.environments).join(",") || "-"}`,
	);
	io.out(
		`runner ${cfg.account}/${s.id}: queues ${s.queues.join(",") || "-"}, capacity ${capacityText(s.capacity)}, nats ${cfg.natsUrl}`,
	);
	return bad ? EXIT.error : EXIT.ok;
}

/** Dry run: which target would take this dispatch, and why. */
async function cmdRoute(
	path: string,
	file: string | undefined,
	f: Flags,
	io: Io,
): Promise<number> {
	const cfg = await loadConfig(path);
	const s = applyFlags(cfg?.runner ?? defaultSettings("dry-run"), f, io.cwd);
	const { routing, source } = await routingFor(path, s, f, io);
	const d = await sampleDispatch(file, f, io);
	const r = route(d, routing, s.providers, {
		agentProvider: s.agent.provider,
	});
	if (r.ok) {
		io.out(decisionLine(r, s.id));
		if (r.binding)
			io.out(
				`checkout ${r.binding.dir}${r.binding.allowSetup ? " (setup allowed)" : ""}`,
			);
	} else io.out(`decline: ${r.reason}`);
	for (const w of r.why) io.out(`  ${w}`);
	io.out(`  routing: ${source}`);
	return r.ok ? EXIT.ok : EXIT.error;
}

/** The supervisor's PID, set in a worker's environment (supervisor.ts). */
const SUPERVISOR_ENV = "MASTERMIND_RUNNER_SUPERVISOR";
/** The supervisor's state for the worker (JSON SupervisorState). */
const AUTO_UPDATE_ENV = "MASTERMIND_RUNNER_AUTO_UPDATE";

/** The auto-update mode of these settings for this executable. */
export function autoUpdateMode(
	s: RunnerSettings,
	version: string,
	exe: string,
	url: string,
): AutoUpdateMode {
	if (s.autoUpdate === false) return { kind: "off", why: "--no-auto-update" };
	const cannot = cannotUpdate(version, exe, url);
	if (cannot) return { kind: "off", why: cannot.split(":")[0] ?? cannot };
	if (s.pin) return { kind: "pin", version: s.pin };
	return { kind: "on" };
}

/**
 * `start` is the supervisor (supervisor.ts): one process per config
 * (lock.ts), it starts one worker and restarts and updates it. The worker
 * (the same command with MASTERMIND_RUNNER_SUPERVISOR set to its parent)
 * runs the runner with its own session id (mm-210.79): a second start
 * refuses with the PID; Mastermind tells an older process that a newer one
 * replaced it.
 */
async function cmdStart(
	path: string,
	f: Flags,
	io: Io,
	argv: string[],
): Promise<number> {
	const cfg = await requireConfig(path);
	const settings = applyFlags(cfg.runner, f, io.cwd);
	if (!settings.queues.length) throw new UsageError("no queues (--queue)");
	const session: Session = {
		session: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
	};
	const parent = io.env[SUPERVISOR_ENV];
	if (parent) {
		// The worker: the supervisor holds the lock.
		if (Number(parent) !== process.ppid)
			throw new UsageError(
				`${SUPERVISOR_ENV}=${parent} is not this process's parent: run mastermind-runner start`,
			);
		return await runStart(path, f, io, cfg, settings, session, {
			supervisor: Number(parent),
			autoUpdate: workerAutoUpdateLine(io.env[AUTO_UPDATE_ENV]),
		});
	}
	let lock: Awaited<ReturnType<typeof acquireLock>>;
	try {
		lock = await acquireLock(lockPath(path), {
			pid: process.pid,
			runner: settings.id,
			...session,
			version: VERSION,
		});
	} catch (error) {
		if (!(error instanceof LockedError)) throw error;
		io.err(error.message);
		return EXIT.usage;
	}
	try {
		// The auto-update choice is kept without --save (mm-210.88).
		if (
			(f["auto-update"] || f["no-auto-update"] || f.pin) &&
			(cfg.runner.autoUpdate !== settings.autoUpdate ||
				cfg.runner.pin !== settings.pin)
		) {
			const runner = { ...cfg.runner, autoUpdate: settings.autoUpdate };
			if (settings.pin) runner.pin = settings.pin;
			else delete runner.pin;
			await saveConfig(path, { ...cfg, runner });
		}
		return await superviseStart(io, cfg, settings, argv);
	} finally {
		await lock.release().catch(() => {});
	}
}

/** The saved auto-update choice, for `status` when no worker said its line. */
function configModeLine(r: RunnerSettings): string {
	if (r.autoUpdate === false) return "off (--no-auto-update)";
	return r.pin ? `pinned to ${r.pin}` : "on";
}

/** The supervisor's state line for this worker; null: none or unreadable. */
function workerAutoUpdateLine(v: string | undefined): string | null {
	if (!v) return null;
	try {
		return autoUpdateLine(JSON.parse(v) as SupervisorState);
	} catch {
		return null;
	}
}

async function superviseStart(
	io: Io,
	cfg: RunnerConfig,
	settings: RunnerSettings,
	argv: string[],
): Promise<number> {
	const url = io.env.MASTERMIND_URL ?? cfg.mastermindUrl;
	const exe = io.exe ?? process.execPath;
	// Run from source: bun <cli.ts> <args>; installed: <exe> <args>.
	const command =
		basename(exe) === "bun"
			? [exe, Bun.argv[1] ?? "", ...argv]
			: [exe, ...argv];
	const mode = autoUpdateMode(settings, VERSION, exe, url);
	const stagePath = join(dirname(exe), `.${basename(exe)}.next`);
	const log = (line: string) => io.err(`${stamp()} ${line}`);
	const stopping = new AbortController();
	const onSignal = () => stopping.abort();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	// The worker's drain signal must not end the supervisor.
	const ignore = () => {};
	process.on("SIGUSR2", ignore);
	try {
		return await supervise({
			version: VERSION,
			mode,
			signal: stopping.signal,
			log,
			spawn: (state) => {
				const p = Bun.spawn(command, {
					env: {
						...io.env,
						[SUPERVISOR_ENV]: String(process.pid),
						[AUTO_UPDATE_ENV]: JSON.stringify(state),
					},
					cwd: io.cwd,
					stdin: "ignore",
					stdout: "inherit",
					stderr: "inherit",
				});
				return {
					pid: p.pid,
					exited: p.exited,
					kill: (sig) => {
						try {
							p.kill(sig);
						} catch {}
					},
				};
			},
			serverVersion: () => serverVersion(url, io.fetch),
			stage: () =>
				stageUpdate({
					url,
					exe,
					path: stagePath,
					...(io.fetch ? { fetch: io.fetch } : {}),
					...(io.runVersion ? { runVersion: io.runVersion } : {}),
				}),
			install: () => installStaged({ version: "", path: stagePath }, exe, true),
			discard: () => rm(stagePath, { force: true }),
			rollback: () => rollbackInstall(exe),
		});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGUSR2", ignore);
	}
}

type Session = { session: string; startedAt: string };

async function runStart(
	path: string,
	f: Flags,
	io: Io,
	cfg: RunnerConfig,
	settings: RunnerSettings,
	session: Session,
	worker: { supervisor: number; autoUpdate: string | null },
): Promise<number> {
	const { routing, source } = await routingFor(path, settings, f, io);
	if (f.save) await saveConfig(path, { ...cfg, runner: settings });
	const natsUrl = io.env.MASTERMIND_NATS_URL ?? cfg.natsUrl;
	const diag = new Diagnostics(settings, VERSION);
	diag.session = session;
	diag.autoUpdate = worker.autoUpdate;
	const log = (line: string) => {
		io.err(`${stamp()} ${line}`);
		diag.log(line);
	};
	// Box mode (default): the engine must answer before any work is taken.
	// No engine: the runner still starts and reports it (readiness, mm-210.59),
	// and tries again on every re-check. Box steps go to the ticket through
	// the runner (made below).
	let runner: Runner | undefined;
	const noBox = f["no-box"] === true;
	let box: Awaited<ReturnType<typeof startBoxMode>> | null = null;
	let boxCheck: BoxCheck | undefined = noBox ? null : undefined;
	const checkBox = async () => {
		if (noBox) return;
		try {
			if (box) await box.driver.ping();
			else
				box = await startBoxMode({
					runnerId: settings.id,
					env: io.env,
					image: f["box-image"],
					...(f["no-paseo-link"] ? { paseoLink: false as const } : {}),
					outDir: join(dirname(path), "results"),
					log,
					onStep: (beadId, line) => runner?.progress(beadId, line),
					// Inputs and outputs on this account's files bucket (mm-210.60).
					files: () =>
						conn && !conn.isClosed() ? natsBoxFiles(conn, cfg.account) : null,
				});
			// The installed runtimes (gVisor readiness per environment, mm-210.63).
			const runtimes = await box.driver.runtimes?.().catch(() => undefined);
			boxCheck = runtimes ? { ok: true, runtimes } : { ok: true };
		} catch (error) {
			boxCheck = {
				ok: false,
				problem: `box engine: ${error instanceof Error ? error.message : error}`,
				fix: "start Docker or Podman (DOCKER_HOST), or run with --no-box at your own risk",
			};
		}
	};
	if (noBox)
		log(
			"WARNING: --no-box: agents run on this machine without a box (owner's risk); every task reports it",
		);
	// Readiness: the runner asks for work only when it is ready (readiness.ts).
	let secrets: SecretsState | undefined;
	let access: AccessMap | undefined;
	/** Set while the worker drains for an update (supervisor.ts). */
	let updating: string | null = null;
	let restart = false;
	/** Mastermind's `superseded` line: a newer process of this runner runs. */
	let superseded: string | null = null;
	let publishNow = async () => {};
	/**
	 * The provider refused the box's model credential (mm-210.81): kept in
	 * login-gate.json, so a separate `doctor --deep` can set it and a restart
	 * keeps it.
	 */
	const gate0 = noBox ? null : await readGate(path);
	let loginRefused: LoginRefused | null = gate0?.refused ?? null;
	let gateAt = gate0?.at ?? "";
	if (loginRefused)
		log(
			`error: the agent's provider refused ${loginRefused.secret} (${loginRefused.problem}, ${loginRefused.at}); the environments that need it take no work; fix: ${loginFix(loginRefused.secret)}`,
		);
	const reevaluate = () => {
		const r = evaluate({
			loginRefused,
			onboarded: !!cfg.onboardedAt,
			checks: diag.checks,
			box: boxCheck,
			secrets,
			access,
			updating,
			settings,
			routing,
			previous: diag.readiness,
		});
		if (sameReadiness(diag.readiness, r)) {
			diag.readiness = r;
			return;
		}
		diag.readiness = r;
		log(readinessLine(r));
		void publishNow().then(() => runner?.readinessChanged());
	};
	/** Take the gate file when it is newer (a doctor --deep in another process). */
	const adoptGate = (g: GateState | null) => {
		if (!g || g.at <= gateAt) return;
		gateAt = g.at;
		const was = loginRefused;
		loginRefused = g.refused;
		if (g.refused && g.refused.hash !== was?.hash)
			log(
				`error: the agent's provider refused ${g.refused.secret} (${g.refused.problem}); the environments that need it take no work until it changes; fix: ${loginFix(g.refused.secret)}`,
			);
		else if (!g.refused && was)
			log(
				`login: the doctor's box probe passed; ${was.secret} is accepted again`,
			);
		reevaluate();
	};
	/** Set or clear the refusal here and in the file. */
	const setGate = (refused: LoginRefused | null) => {
		const g = { refused, at: new Date().toISOString() };
		void writeGate(path, g).catch((error) =>
			log(`login gate: cannot write ${gatePath(path)}: ${error}`),
		);
		adoptGate(g);
	};
	/** A doctor --deep in this process (the operator's remote doctor). */
	const probeDone = async (r: DoctorReport) => {
		if (noBox) return;
		adoptGate(
			await recordProbe(path, r, await modelFor(io), MODEL_SECRETS).catch(
				() => null,
			),
		);
	};
	/** A changed (or removed) value lifts the refusal: checked with the secrets. */
	const refusalCheck = async () => {
		const refused = loginRefused;
		if (!refused) return;
		const hit = await lookupSecret(refused.secret, {
			store: await new SecretStore(secretsPath(io.env))
				.load()
				.catch(() => ({})),
			env: io.env,
		});
		if (refusalHolds(refused, hit?.value)) return;
		log(`login: ${refused.secret} changed; its environments are checked again`);
		setGate(null);
	};
	let conn: Awaited<ReturnType<typeof connectRunner>> | null = null;
	const statusSubject = subjects.runnerStatus(cfg.account, settings.id);
	const reporter = startReporter({
		diagnostics: diag,
		publish: (d) => {
			if (conn && !conn.isClosed()) publish(conn, statusSubject, d);
		},
		file: statusPath(path),
		check: async () => {
			// A local `doctor` run writes doctor.json; send it as lastDoctor.
			diag.doctor(await readDoctor(path));
			if (!noBox) adoptGate(await readGate(path));
			const c = await runChecks(settings, {
				paseoHost: f["paseo-host"],
				login: noBox,
			});
			diag.checks = c;
			reevaluate();
			return c;
		},
	});
	publishNow = () => reporter.send();
	await checkBox();
	reevaluate();
	const stopping = new AbortController();
	const onSignal = () => stopping.abort();
	const mastermindUrl = io.env.MASTERMIND_URL ?? cfg.mastermindUrl;
	const verify = () => checkCredential(mastermindUrl, cfg.credential);
	let onRevoked = () => {};
	const revoked = new Promise<"revoked">((r) => {
		onRevoked = () => r("revoked");
	});
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	// The supervisor has a new version (SIGUSR2): take no new work, let the
	// running tasks finish (heartbeats go on), then end with EXIT.restart.
	let draining = false;
	const onDrain = () => {
		if (draining || stopping.signal.aborted) return;
		draining = true;
		void drainWorker({
			running: () => runner?.inFlight().length ?? 0,
			hold: () => {
				updating =
					"updating: no new work until the running tasks finish (supervisor)";
				reevaluate();
			},
			done: () => {
				restart = true;
				stopping.abort();
			},
			log,
			signal: stopping.signal,
		});
	};
	process.on("SIGUSR2", onDrain);
	// The supervisor is gone (killed): this worker stops too, so a new start
	// never meets a second worker.
	const parentWatch = setInterval(() => {
		if (process.ppid !== worker.supervisor) {
			log("supervisor gone: this worker stops");
			stopping.abort();
		}
	}, 5_000);
	let finalState: "stopping" | "revoked" = "stopping";
	try {
		let nc: Awaited<ReturnType<typeof connectRunner>>;
		try {
			nc = await connectRunner({
				natsUrl,
				credential: cfg.credential,
				inboxPrefix: cfg.inboxPrefix,
				name: `mastermind-runner ${cfg.account}/${settings.id}`,
				log,
				signal: stopping.signal,
				verify,
				onRevoked: () => onRevoked(),
				onStatus: (type) => {
					if (type === "disconnect") diag.set("connecting");
					if (type === "reconnect" && conn) {
						diag.reconnects++;
						diag.natsServer = conn.getServer();
						diag.set("connected");
						diag.changed();
					}
				},
			});
		} catch (error) {
			if (error instanceof RevokedError) {
				finalState = "revoked";
				await saveConfig(path, { ...cfg, state: "revoked" });
			}
			throw error;
		}
		conn = nc;
		diag.natsServer = nc.getServer();
		diag.set("connected");
		const info = { ...runnerInfo(cfg, settings, routing), ...session };
		// `next` names only the environments that are ready here.
		const nextInfo = (): RunnerInfo => ({
			...info,
			environments: diag.readiness?.readyEnvironments ?? [],
		});
		let notReadySaid = "";
		runner = new Runner({
			client: natsClient(nc, nextInfo, {
				onNotReady: (reasons) => {
					const line = reasons.join("; ");
					if (line !== notReadySaid)
						log(`error: Mastermind gives no work: not ready: ${line}`);
					notReadySaid = line;
				},
				onSuperseded: (line) => {
					if (superseded) return;
					superseded = line;
					log(`error: ${line}`);
					stopping.abort();
				},
			}),
			launcher: noBox
				? new PaseoLauncher({ host: f["paseo-host"] })
				: {
						run: (spec, signal) =>
							box
								? box.launcher.run(spec, signal)
								: Promise.reject(new Error("the box engine is not ready")),
					},
			...(noBox
				? { noBox: true }
				: {
						check: (d, s, decision) =>
							box
								? box.check(d, s, decision)
								: Promise.resolve({
										ok: false as const,
										reason: "the box engine is not ready",
									}),
					}),
			readiness: () => diag.readiness,
			// Box mode: a refused model credential stops work for its environments (mm-210.81).
			...(noBox
				? {}
				: {
						onAgentFailure: (text: string, env: Record<string, string>) => {
							const r = loginRefusal(
								providerLoginMessage(text),
								env,
								MODEL_SECRETS,
							);
							if (r) setGate(r);
						},
					}),
			settings,
			routing,
			setupMemory: new FileSetupMemory(join(dirname(path), "setup-state.json")),
			log,
			providerStatus: () => diag.checks.providers,
			// Provider, mode and model are checked against the runner's Paseo (mm-210.84).
			paseoReport: () =>
				diag.checks.paseoProviders && {
					...(f["paseo-host"] ? { host: f["paseo-host"] } : {}),
					providers: diag.checks.paseoProviders,
				},
			onChange: () => diag.changed(),
		});
		diag.loop = runner;
		runner.start();
		// Direct offers: work sent to this runner or its account (mm-210.32).
		serveOffers(nc, { runner: info, taker: runner, log });
		// The operator's remote doctor (debug doctor <account>/<runner>).
		serveDoctor(nc, {
			account: cfg.account,
			runnerId: settings.id,
			allowRemoteProbe: settings.allowRemoteProbe === true,
			run: (deep) =>
				runDoctor({
					...doctorInput(
						path,
						cfg,
						settings,
						routing,
						source,
						io,
						noBox
							? { noBox: true }
							: {
									driver: box?.driver ?? new DockerDriver({ env: io.env }),
									image: boxImage(f, io),
									// The probe goes the way this runner's tasks go.
									...(box ? { probe: box.launcher } : {}),
								},
					),
					deep,
				}),
			onReport: (r) => {
				diag.doctor(r);
				void probeDone(r);
				void writeDoctor(path, r).catch(() => {});
			},
			log,
		});
		// Needed secret names: at start and every few minutes (names only).
		// The same re-check looks at the box engine again (readiness).
		let lastMissing = "";
		const learnSecrets = async () => {
			await checkBox();
			await refusalCheck().catch(() => {});
			try {
				const x = await secretsFor(cfg, routing, io);
				// Git access per environment (mm-lnm), set with the secrets.
				access = await accessFor(x, routing, io);
				secrets = x;
				diag.secrets = x.diagnostics;
				const missing = x.diagnostics.missing.join(", ");
				if (missing && missing !== lastMissing)
					log(
						`error: missing secrets: ${missing}; fix: ${x.diagnostics.missing.map((m) => `mastermind-runner secrets set ${m}`).join("; ")}`,
					);
				lastMissing = missing;
				diag.changed();
			} catch (error) {
				const problem = `secrets: ${error instanceof Error ? error.message : error}`;
				log(`error: ${problem}`);
				secrets = {
					rows: [],
					needs: null,
					problem,
					diagnostics: { needed: [], missing: [], needsAt: null, problem },
				};
			}
			reevaluate();
		};
		// The server's version: at start and every re-check, for the notice;
		// the supervisor updates (supervisor.ts, mm-210.88).
		const watch = versionWatch({
			version: VERSION,
			serverVersion: () => serverVersion(mastermindUrl, io.fetch),
			autoUpdate: false,
			idle: () => (runner?.inFlight().length ?? 0) === 0,
			waitIdle: async (signal) => {
				while (!signal?.aborted && (runner?.inFlight().length ?? 0) > 0)
					await Bun.sleep(2_000);
			},
			update: () =>
				selfUpdate({
					url: mastermindUrl,
					version: VERSION,
					fetch: io.fetch,
					...(io.exe ? { exe: io.exe } : {}),
					...(io.runVersion ? { runVersion: io.runVersion } : {}),
				}),
			restart: () => {
				restart = true;
				stopping.abort();
			},
			onNotice: (n) => {
				diag.update = n;
				diag.changed();
			},
			onDraining: (why) => {
				updating = why;
				reevaluate();
			},
			log,
			signal: stopping.signal,
		});
		const recheck = () => {
			void learnSecrets();
			void watch.tick();
		};
		recheck();
		const secretsTimer = setInterval(recheck, RECHECK_MS);
		stopping.signal.addEventListener("abort", () =>
			clearInterval(secretsTimer),
		);
		void nc.closed().then(() => clearInterval(secretsTimer));
		log(
			`runner ${cfg.account}/${settings.id} up: queues ${settings.queues.join(",")}, capacity ${capacityText(settings.capacity)}, routing ${source}`,
		);
		const closed = nc.closed();
		const stopped = new Promise<"stop">((r) =>
			stopping.signal.addEventListener("abort", () => r("stop"), {
				once: true,
			}),
		);
		const why = await Promise.race([closed, stopped, revoked]);
		log("runner stopping");
		diag.set(why === "revoked" ? "revoked" : "stopping");
		// Revoked: no request can succeed, so fail the in-flight ones now.
		if (why === "revoked") await nc.close().catch(() => {});
		await runner.stop();
		await reporter.stop();
		if (why === "stop") {
			await nc.drain().catch(() => {});
			if (superseded) return EXIT.superseded;
			return restart ? EXIT.restart : EXIT.ok;
		}
		// NATS refuses the credential also while the auth callout is down (a
		// NATS restart): only Mastermind's own answer marks the runner revoked.
		if (
			why === "revoked" ||
			(why && isAuthFailure(why) && (await verify()) === "revoked")
		) {
			await nc.close().catch(() => {});
			finalState = "revoked";
			await saveConfig(path, { ...cfg, state: "revoked" });
			throw new RevokedError("Mastermind revoked this runner");
		}
		log(`nats closed: ${why ?? "no error"}`);
		return EXIT.error;
	} finally {
		diag.set(finalState);
		await reporter.stop();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGUSR2", onDrain);
		clearInterval(parentWatch);
	}
}

if (import.meta.main) {
	const code = await main(Bun.argv.slice(2), {
		env: process.env,
		out: (l) => console.log(l),
		err: (l) => console.error(l),
		cwd: process.cwd(),
	});
	process.exit(code);
}
