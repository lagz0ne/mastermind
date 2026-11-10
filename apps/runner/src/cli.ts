#!/usr/bin/env bun
/**
 * mastermind-runner: the adapter a user runs on their own machine. It
 * connects to Mastermind over NATS as a service account of the user's account,
 * takes work from queues and runs agents for it through Paseo.
 *
 *   mastermind-runner enroll <token> --url <mastermind url> [settings]
 *   mastermind-runner start [settings] [--save]
 *   mastermind-runner check [settings]
 *   mastermind-runner status
 *   mastermind-runner --version
 *
 * Settings: --queue <q> (repeat), --capacity <n>, --capability <c> (repeat),
 * --providers a,b, --workdir <dir>, --repo <url>=<dir> (repeat), --id <id>,
 * --provider <p>, --model <m>, --mode <m>, --assistant-provider <p>,
 * --allow-setup, --paseo-host <host>.
 *
 * Environment: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG.
 */
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunnerInfo } from "@mastermind/core";
import { checkRequirement } from "./check.ts";
import {
	connectRunner,
	isAuthFailure,
	natsClient,
	RevokedError,
} from "./client.ts";
import {
	ConfigError,
	configPath,
	loadConfig,
	type RunnerConfig,
	type RunnerSettings,
	saveConfig,
} from "./config.ts";
import { EnrolError, enrol } from "./enroll.ts";
import { PaseoLauncher } from "./launcher.ts";
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
  mastermind-runner status
  mastermind-runner --version

settings: --queue <q>... --capacity <n> --capability <c>... --providers a,b
  --workdir <dir> --repo <url>=<dir>... --id <id> --provider <p> --model <m>
  --mode <m> --assistant-provider <p> --allow-setup --paseo-host <host>
env: MASTERMIND_URL, MASTERMIND_NATS_URL, MASTERMIND_RUNNER_CONFIG`;

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

export function runnerInfo(cfg: RunnerConfig, s: RunnerSettings): RunnerInfo {
	return {
		id: s.id,
		account: cfg.account,
		serviceAccount: cfg.serviceAccount.id,
		providers: s.providers,
		capabilities: s.capabilities,
		capacity: s.capacity,
		queues: s.queues,
		version: VERSION,
	};
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
	if (!s.workdir && !Object.keys(s.repos).length) {
		bad++;
		io.out("✗ no workdir and no repos (--workdir, --repo)");
	}
	io.out(
		`runner ${cfg.account}/${s.id}: queues ${s.queues.join(",") || "-"}, capacity ${s.capacity}, nats ${cfg.natsUrl}`,
	);
	return bad ? EXIT.error : EXIT.ok;
}

async function cmdStart(path: string, f: Flags, io: Io): Promise<number> {
	const cfg = await requireConfig(path);
	const settings = applyFlags(cfg.runner, f, io.cwd);
	if (!settings.queues.length) throw new UsageError("no queues (--queue)");
	if (f.save) await saveConfig(path, { ...cfg, runner: settings });
	const natsUrl = io.env.MASTERMIND_NATS_URL ?? cfg.natsUrl;
	const log = (line: string) => io.err(`${stamp()} ${line}`);
	const stopping = new AbortController();
	const onSignal = () => stopping.abort();
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
			});
		} catch (error) {
			if (error instanceof RevokedError)
				await saveConfig(path, { ...cfg, state: "revoked" });
			throw error;
		}
		const runner = new Runner({
			client: natsClient(nc, runnerInfo(cfg, settings)),
			launcher: new PaseoLauncher({ host: f["paseo-host"] }),
			settings,
			log,
		});
		runner.start();
		log(
			`runner ${cfg.account}/${settings.id} up: queues ${settings.queues.join(",")}, capacity ${settings.capacity}`,
		);
		const closed = nc.closed();
		const stopped = new Promise<"stop">((r) =>
			stopping.signal.addEventListener("abort", () => r("stop"), {
				once: true,
			}),
		);
		const why = await Promise.race([closed, stopped]);
		log("runner stopping");
		await runner.stop();
		if (why === "stop") {
			await nc.drain().catch(() => {});
			return EXIT.ok;
		}
		if (why && isAuthFailure(why)) {
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
