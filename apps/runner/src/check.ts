/**
 * Environment checks before a dispatch starts an agent. The user owns the
 * environment; the runner only checks it and refuses work it cannot do, so
 * Mastermind can give the bead to another runner.
 *
 * Requirements (bead labels `req:<x>`, sent as `env.requires`):
 *
 *   os:<platform>         process.platform, for example os:linux
 *   arch:<arch>           process.arch, for example arch:x64
 *   <tool>                an executable on PATH, for example git
 *   <tool>>=<version>     on PATH and `<tool> --version` at least <version>
 *   <ns>:<anything else>  opaque (gpu:a100): trusted when the runner offers it
 *
 * Every requirement must also be one of the runner's own capabilities.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Dispatch } from "@mastermind/core";
import type { RunnerSettings } from "./config.ts";
import type { Decision } from "./routing.ts";
import { missingReason, resolveSecrets } from "./secrets/needs.ts";
import {
	type SecretSource,
	SecretStore,
	secretsPath,
} from "./secrets/store.ts";

export type CheckResult =
	| { ok: true; cwd: string; env: Record<string, string> }
	| { ok: false; reason: string };

export type CheckDeps = {
	which?: (bin: string) => string | null;
	/** Output of `<tool> --version`, or null when it cannot run. */
	version?: (bin: string) => Promise<string | null>;
	/** Run one setup or check command in `cwd`; returns the exit code and output tail. */
	sh?: (cmd: string, cwd: string) => Promise<{ code: number; tail: string }>;
	/** Is `dir` inside a git work tree? */
	isGitDir?: (dir: string) => Promise<boolean>;
	env?: Record<string, string | undefined>;
	/** Setup already done; default: in this process only. */
	setupMemory?: SetupMemory;
	/** Stored secret values; default: the local secrets file (secrets/store.ts). */
	secrets?: SecretSource;
	platform?: string;
	arch?: string;
};

const TOOL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const VERSIONED = /^([A-Za-z0-9][A-Za-z0-9._+-]*)>=(\d+(?:\.\d+)*)$/;

/** -1, 0 or 1, comparing dotted numbers (1.10 > 1.9). */
export function compareVersions(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/** The first dotted version in a `--version` output. */
export function versionIn(output: string): string | null {
	return /\d+(?:\.\d+)+/.exec(output)?.[0] ?? null;
}

async function toolVersion(bin: string): Promise<string | null> {
	try {
		const proc = Bun.spawn([bin, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), 5_000);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		clearTimeout(timer);
		await proc.exited;
		return `${out}\n${err}`;
	} catch {
		return null;
	}
}

async function runShell(cmd: string, cwd: string) {
	const proc = Bun.spawn(["sh", "-c", cmd], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timer = setTimeout(() => proc.kill(), 10 * 60_000);
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	const code = await proc.exited;
	return { code, tail: `${out}${err}`.trim().slice(-500) };
}

async function gitDir(dir: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "-C", dir, "rev-parse"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/** Why `req` is not met, or null when it is. */
export async function checkRequirement(
	req: string,
	settings: Pick<RunnerSettings, "capabilities">,
	deps: CheckDeps = {},
): Promise<string | null> {
	if (!settings.capabilities.includes(req))
		return `${req}: not offered by this runner`;
	const which = deps.which ?? Bun.which;
	if (req.startsWith("os:")) {
		const p = deps.platform ?? process.platform;
		return req.slice(3) === p ? null : `${req}: this runner is os:${p}`;
	}
	if (req.startsWith("arch:")) {
		const a = deps.arch ?? process.arch;
		return req.slice(5) === a ? null : `${req}: this runner is arch:${a}`;
	}
	const versioned = VERSIONED.exec(req);
	if (versioned) {
		const [, tool, min] = versioned as unknown as [string, string, string];
		if (!which(tool)) return `${req}: ${tool} is not on PATH`;
		const out = await (deps.version ?? toolVersion)(tool);
		const have = out ? versionIn(out) : null;
		if (!have) return `${req}: cannot read the version of ${tool}`;
		return compareVersions(have, min) >= 0
			? null
			: `${req}: ${tool} is ${have}`;
	}
	if (TOOL.test(req)) return which(req) ? null : `${req}: not on PATH`;
	// Opaque, namespaced capability: the runner offers it, that is the check.
	return null;
}

/** Local checkout for a repo URL; tolerant of `.git` and a trailing slash. */
export function repoDir(
	repos: Record<string, string>,
	repo: string,
): string | undefined {
	const norm = (u: string) => u.replace(/\/+$/, "").replace(/\.git$/, "");
	if (repos[repo]) return repos[repo];
	const want = norm(repo);
	for (const [url, dir] of Object.entries(repos))
		if (norm(url) === want) return dir;
	return undefined;
}

/**
 * Remembers which setup ran in which checkout (by hash of the commands), so
 * setup runs once per checkout and per setup.
 */
export interface SetupMemory {
	has(dir: string, hash: string): Promise<boolean>;
	mark(dir: string, hash: string): Promise<void>;
}

export class MemorySetupMemory implements SetupMemory {
	readonly done = new Map<string, string>();
	async has(dir: string, hash: string) {
		return this.done.get(dir) === hash;
	}
	async mark(dir: string, hash: string) {
		this.done.set(dir, hash);
	}
}

/** A JSON file `{ "<dir>": "<hash>" }`, for example `setup-state.json` next to the config. */
export class FileSetupMemory implements SetupMemory {
	constructor(readonly path: string) {}
	async #read(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await Bun.file(this.path).text());
		} catch {
			return {};
		}
	}
	async has(dir: string, hash: string) {
		return (await this.#read())[dir] === hash;
	}
	async mark(dir: string, hash: string) {
		const all = { ...(await this.#read()), [dir]: hash };
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, `${JSON.stringify(all, null, "\t")}\n`);
		await rename(tmp, this.path);
	}
}

export function setupHash(setup: string[]): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(setup))
		.digest("hex")
		.slice(0, 16);
}

/** One setup at a time per checkout, inside this process. */
const setupLocks = new Map<string, Promise<unknown>>();
async function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const before = setupLocks.get(dir) ?? Promise.resolve();
	const run = before.then(fn, fn);
	const tail = run.catch(() => {});
	setupLocks.set(dir, tail);
	try {
		return await run;
	} finally {
		if (setupLocks.get(dir) === tail) setupLocks.delete(dir);
	}
}

/** Where the agent works when the dispatch names no bound environment. */
async function legacyDir(
	env: Dispatch["env"],
	settings: RunnerSettings,
	deps: CheckDeps,
): Promise<{ cwd: string } | { reason: string }> {
	if (env.repo) {
		const cwd = repoDir(settings.repos, env.repo);
		if (!cwd) return { reason: `no local checkout for ${env.repo}` };
		if (!(await (deps.isGitDir ?? gitDir)(cwd)))
			return { reason: `checkout of ${env.repo} is not a git dir` };
		return { cwd };
	}
	if (!settings.workdir) return { reason: "runner has no workdir" };
	return { cwd: settings.workdir };
}

/**
 * Check the hard requirements of a dispatch on the routed decision, run its
 * setup (once per checkout and setup hash, when allowed) and its check
 * commands (every time). On success the agent may start in `cwd` with `env`
 * (the declared secrets).
 */
export async function checkDispatch(
	dispatch: Pick<Dispatch, "stage" | "env">,
	settings: RunnerSettings,
	decision: Pick<Extract<Decision, { ok: true }>, "binding">,
	deps: CheckDeps = {},
): Promise<CheckResult> {
	const env = dispatch.env;
	const unmet: string[] = [];
	for (const req of env.requires ?? []) {
		const why = await checkRequirement(req, settings, deps);
		if (why) unmet.push(why);
	}
	if (unmet.length) return { ok: false, reason: unmet.join("; ") };

	const b = decision.binding;
	const where = b ? { cwd: b.dir } : await legacyDir(env, settings, deps);
	if ("reason" in where) return { ok: false, reason: where.reason };
	const { cwd } = where;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory())
		return {
			ok: false,
			reason: b
				? `the checkout of environment ${b.name} (${cwd}) is missing`
				: "the runner's working directory is missing",
		};

	const procEnv = deps.env ?? process.env;
	let store: Record<string, string>;
	try {
		store = await (deps.secrets ?? new SecretStore(secretsPath())).load();
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	const { values: secrets, missing } = await resolveSecrets(env.secrets ?? [], {
		store,
		env: procEnv,
		binding: b?.env,
	});
	if (missing.length) return { ok: false, reason: missingReason(missing) };

	const sh = deps.sh ?? runShell;
	const setup = env.setup ?? [];
	if (setup.length) {
		const allowed = b ? b.allowSetup === true : settings.allowSetup;
		if (!allowed)
			return {
				ok: false,
				reason: b
					? `setup commands are off for environment ${b.name} (allowSetup)`
					: "setup commands are off on this runner",
			};
		const memory = deps.setupMemory ?? defaultMemory;
		const hash = setupHash(setup);
		const failed = await locked(cwd, async () => {
			if (await memory.has(cwd, hash)) return null;
			for (const cmd of setup) {
				const res = await sh(cmd, cwd);
				if (res.code !== 0)
					return `setup failed (exit ${res.code}): ${cmd}${res.tail ? `\n${res.tail}` : ""}`;
			}
			await memory.mark(cwd, hash);
			return null;
		});
		if (failed) return { ok: false, reason: failed };
	}
	for (const cmd of env.check ?? []) {
		const res = await sh(cmd, cwd);
		if (res.code !== 0)
			return {
				ok: false,
				reason: `check failed (exit ${res.code}): ${cmd}${res.tail ? `\n${res.tail}` : ""}`,
			};
	}
	return { ok: true, cwd, env: secrets };
}

const defaultMemory = new MemorySetupMemory();
