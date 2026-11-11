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
 *   mastermind-runner status
 *   mastermind-runner --version
 *
 * Settings: --queue <q> (repeat), --capacity <n>, --capability <c> (repeat),
 * --providers a,b, --workdir <dir>, --repo <url>=<dir> (repeat), --id <id>,
 * --provider <p>, --model <m>, --mode <m>, --assistant-provider <p>,
 * --allow-setup, --paseo-host <host>, --routing <file>.
 *
 * Environment: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG,
 * MASTERMIND_RUNNER_ROUTING.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	DISPATCH_STAGES,
	type Dispatch,
	type DispatchStage,
	type RunnerInfo,
} from "@mastermind/core";
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
import { EnrolError, enrol } from "./enroll.ts";
import { PaseoLauncher } from "./launcher.ts";
import {
	decisionLine,
	lintRouting,
	loadRouting,
	type Routing,
	route,
	routingPath,
} from "./routing.ts";
import { Runner } from "./runner.ts";

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
	"paseo-host": { type: "string" },
	routing: { type: "string" },
	env: { type: "string" },
	stage: { type: "string" },
	type: { type: "string" },
	label: { type: "string", multiple: true },
	priority: { type: "string" },
	save: { type: "boolean" },
	force: { type: "boolean" },
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
  mastermind-runner start [settings] [--save]
  mastermind-runner check [settings]
  mastermind-runner route [dispatch.json] [--env <name>] [--queue <q>]
      [--stage work] [--type <t>] [--label <l>]... [--priority <n>]
  mastermind-runner status
  mastermind-runner --version

settings: --queue <q>... --capacity <n> --capability <c>... --providers a,b
  --workdir <dir> --repo <url>=<dir>... --id <id> --provider <p> --model <m>
  --mode <m> --assistant-provider <p> --allow-setup --paseo-host <host>
  --routing <file> (default: routing.json next to the config)
env: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG,
  MASTERMIND_RUNNER_ROUTING`;

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
	if (f.capacity !== undefined) {
		const n = Number(f.capacity);
		if (!Number.isInteger(n) || n < 1)
			throw new UsageError("--capacity must be a positive integer");
		s.capacity = n;
	}
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
	if (s.workdir && !isAbsolute(s.workdir))
		throw new UsageError("workdir must be absolute");
	return s;
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
};

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
			case "status": {
				const cfg = await loadConfig(path);
				io.out(
					cfg
						? JSON.stringify({ path, ...redact(cfg) }, null, 2)
						: `not enrolled (${path})`,
				);
				return cfg ? EXIT.ok : EXIT.error;
			}
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
		`runner ${cfg.account}/${s.id}: queues ${s.queues.join(",") || "-"}, capacity ${s.capacity}, nats ${cfg.natsUrl}`,
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
	const r = route(d, routing, s.providers);
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
	const log = (line: string) => io.err(`${stamp()} ${line}`);
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
			});
		} catch (error) {
			if (error instanceof RevokedError)
				await saveConfig(path, { ...cfg, state: "revoked" });
			throw error;
		}
		const runner = new Runner({
			client: natsClient(nc, runnerInfo(cfg, settings, routing)),
			launcher: new PaseoLauncher({ host: f["paseo-host"] }),
			settings,
			routing,
			setupMemory: new FileSetupMemory(join(dirname(path), "setup-state.json")),
			log,
		});
		runner.start();
		log(
			`runner ${cfg.account}/${settings.id} up: queues ${settings.queues.join(",")}, capacity ${settings.capacity}, routing ${source}`,
		);
		const closed = nc.closed();
		const stopped = new Promise<"stop">((r) =>
			stopping.signal.addEventListener("abort", () => r("stop"), {
				once: true,
			}),
		);
		const why = await Promise.race([closed, stopped, revoked]);
		log("runner stopping");
		// Revoked: no request can succeed, so fail the in-flight ones now.
		if (why === "revoked") await nc.close().catch(() => {});
		await runner.stop();
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
			await saveConfig(path, { ...cfg, state: "revoked" });
			throw new RevokedError("Mastermind revoked this runner");
		}
		log(`nats closed: ${why ?? "no error"}`);
		return EXIT.error;
	} finally {
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
