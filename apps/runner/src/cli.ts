#!/usr/bin/env bun
/**
 * mastermind-runner: the adapter a user runs on their own machine. It
 * connects to Mastermind over NATS as a service account of the user's account,
 * takes work from queues and runs agents for it through Paseo.
 *
 *   mastermind-runner enroll <token> --url <mastermind url> [settings]
 *   mastermind-runner start [settings] [--save]
 *   mastermind-runner check [settings]
 *   mastermind-runner route [dispatch.json] [--env e --queue q --stage s --type t --label l --priority n]
 *   mastermind-runner status [--json]
 *   mastermind-runner doctor [--deep] [--json] [settings]
 *   mastermind-runner secrets [list|set NAME|unset NAME|check] [--json]
 *   mastermind-runner --version
 *
 * Settings: --queue <q> (repeat), --capacity <n|unlimited>, --capability <c> (repeat),
 * --providers a,b, --workdir <dir>, --repo <url>=<dir> (repeat), --id <id>,
 * --provider <p>, --model <m>, --mode <m>, --assistant-provider <p>,
 * --allow-setup, --allow-remote-probe (the operator may run doctor --deep remotely), --paseo-host <host>, --routing <file>.
 * start: every task runs in a throwaway box (Docker API: DOCKER_HOST or the default socket;
 * --box-image <ref> or MASTERMIND_BOX_IMAGE for environments without an image);
 * --no-box runs agents on this machine instead, at the owner's risk.
 *
 * Environment: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG,
 * MASTERMIND_RUNNER_ROUTING, MASTERMIND_RUNNER_SECRETS.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { publish, subjects } from "@mastermind/bus";
import {
	DISPATCH_STAGES,
	type Dispatch,
	type DispatchStage,
	type RunnerDiagnostics,
	type RunnerInfo,
} from "@mastermind/core";
import { DockerDriver } from "./box/docker.ts";
import { DEFAULT_BOX_IMAGE, startBoxMode } from "./box/launcher.ts";
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
	readDoctor,
	runChecks,
	startReporter,
	statusPath,
	writeDoctor,
} from "./diagnostics.ts";
import { type DoctorBox, formatReport, runDoctor } from "./doctor.ts";
import { EnrolError, enrol } from "./enroll.ts";
import { PaseoLauncher } from "./launcher.ts";
import { serveOffers } from "./offer.ts";
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
import { secretsCommand } from "./secrets/command.ts";
import { type SecretsState, secretsState } from "./secrets/state.ts";
import { secretsPath } from "./secrets/store.ts";

/**
 * The Mastermind commit this runner was built from. The api build (apps/api/build.ts)
 * replaces the expression with the server's GIT_SHA; run from source it is "dev".
 */
export const VERSION = process.env.MASTERMIND_RUNNER_VERSION || "dev";

/** Exit codes. */
export const EXIT = { ok: 0, error: 1, usage: 2, revoked: 3 } as const;

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
	"paseo-host": { type: "string" },
	"no-box": { type: "boolean" },
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
  mastermind-runner enroll <token> --url <mastermind url> [settings]
  mastermind-runner start [settings] [--save] [--box-image <ref>] [--no-box]
      every task runs in a throwaway box (Docker or Podman API: DOCKER_HOST);
      --no-box: agents run on this machine, at your own risk (the ticket says so)
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
  mastermind-runner --version

settings: --queue <q>... --capacity <n|unlimited> --capability <c>... --providers a,b
  --workdir <dir> --repo <url>=<dir>... --id <id> --provider <p> --model <m>
  --mode <m> --assistant-provider <p> --allow-setup --allow-remote-probe --paseo-host <host>
  --routing <file> (default: routing.json next to the config)
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
		providers: s.providers,
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

const stamp = () => new Date().toISOString();

async function requireConfig(path: string): Promise<RunnerConfig> {
	const cfg = await loadConfig(path);
	if (!cfg) throw new UsageError(`not enrolled (no ${path}); run enroll first`);
	if (cfg.state === "revoked")
		throw new RevokedError("this runner was revoked; enroll again");
	return cfg;
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
			case "enroll":
			case "enrol":
				return await cmdEnroll(path, rest[0], f, io);
			case "start":
				return await cmdStart(path, f, io);
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
		if (error instanceof ConfigError || error instanceof EnrolError) {
			io.err(error.message);
			return EXIT.error;
		}
		throw error;
	}
}

/** How often the running runner refreshes the needed secret names. */
const SECRETS_EVERY_MS = 5 * 60_000;

/** A status.json older than this: the runner is probably not running. */
const STALE_MS = 60_000;

async function readStatus(path: string): Promise<RunnerDiagnostics | null> {
	try {
		return (await Bun.file(statusPath(path)).json()) as RunnerDiagnostics;
	} catch {
		return null;
	}
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
	};
}

/** The default image of box mode: --box-image, else MASTERMIND_BOX_IMAGE, else the default. */
function boxImage(f: Flags, io: Io): string {
	return f["box-image"] || io.env.MASTERMIND_BOX_IMAGE || DEFAULT_BOX_IMAGE;
}

/** Step g of a local doctor: box mode unless --no-box. */
function doctorBox(f: Flags, io: Io): DoctorBox {
	return f["no-box"]
		? { noBox: true }
		: { driver: new DockerDriver({ env: io.env }), image: boxImage(f, io) };
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
		...doctorInput(path, cfg, s, routing, source, io, doctorBox(f, io)),
		deep: f.deep === true,
		runnerProblems,
	});
	// The running runner sends it to Mastermind as lastDoctor.
	if (cfg) await writeDoctor(path, report).catch(() => {});
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

async function cmdStart(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await requireConfig(path);
	const settings = applyFlags(cfg.runner, f, io.cwd);
	if (!settings.queues.length) throw new UsageError("no queues (--queue)");
	const { routing, source } = await routingFor(path, settings, f, io);
	if (f.save) await saveConfig(path, { ...cfg, runner: settings });
	const natsUrl = io.env.MASTERMIND_NATS_URL ?? cfg.natsUrl;
	const diag = new Diagnostics(settings, VERSION);
	const log = (line: string) => {
		io.err(`${stamp()} ${line}`);
		diag.log(line);
	};
	// Box mode (default): the engine must answer before any work is taken.
	// Box steps go to the ticket through the runner (made below).
	let runner: Runner | undefined;
	const box = f["no-box"]
		? null
		: await startBoxMode({
				runnerId: settings.id,
				env: io.env,
				image: f["box-image"],
				outDir: join(dirname(path), "results"),
				log,
				onStep: (beadId, line) => runner?.progress(beadId, line),
			});
	if (!box)
		log(
			"WARNING: --no-box: agents run on this machine without a box (owner's risk); every task reports it",
		);
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
			return runChecks(settings, { paseoHost: f["paseo-host"] });
		},
	});
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
		const info = runnerInfo(cfg, settings, routing);
		runner = new Runner({
			client: natsClient(nc, info),
			launcher: box?.launcher ?? new PaseoLauncher({ host: f["paseo-host"] }),
			...(box ? { check: box.check } : { noBox: true }),
			settings,
			routing,
			setupMemory: new FileSetupMemory(join(dirname(path), "setup-state.json")),
			log,
			providerStatus: () => diag.checks.providers,
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
						box
							? { driver: box.driver, image: boxImage(f, io) }
							: { noBox: true },
					),
					deep,
				}),
			onReport: (r) => {
				diag.doctor(r);
				void writeDoctor(path, r).catch(() => {});
			},
			log,
		});
		// Needed secret names: at start and every few minutes (names only).
		let lastMissing = "";
		const learnSecrets = async () => {
			try {
				const x = await secretsFor(cfg, routing, io);
				diag.secrets = x.diagnostics;
				const missing = x.diagnostics.missing.join(", ");
				if (missing && missing !== lastMissing)
					log(
						`error: missing secrets: ${missing}; fix: ${x.diagnostics.missing.map((m) => `mastermind-runner secrets set ${m}`).join("; ")}`,
					);
				lastMissing = missing;
				diag.changed();
			} catch (error) {
				log(
					`error: secrets: ${error instanceof Error ? error.message : error}`,
				);
			}
		};
		void learnSecrets();
		const secretsTimer = setInterval(
			() => void learnSecrets(),
			SECRETS_EVERY_MS,
		);
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
			return EXIT.ok;
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
