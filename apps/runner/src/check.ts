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
import type { Dispatch } from "@mastermind/core";
import type { AgentSettings, RunnerSettings } from "./config.ts";

export type CheckResult =
	| { ok: true; cwd: string; agent: AgentSettings }
	| { ok: false; reason: string };

export type CheckDeps = {
	which?: (bin: string) => string | null;
	/** Output of `<tool> --version`, or null when it cannot run. */
	version?: (bin: string) => Promise<string | null>;
	/** Run one setup command in `cwd`; returns the exit code and output tail. */
	sh?: (cmd: string, cwd: string) => Promise<{ code: number; tail: string }>;
	/** Is `dir` inside a git work tree? */
	isGitDir?: (dir: string) => Promise<boolean>;
	env?: Record<string, string | undefined>;
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

async function runSetup(cmd: string, cwd: string) {
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

/** The agent settings for a dispatch stage, or why there are none. */
export function agentFor(
	dispatch: Pick<Dispatch, "stage" | "env">,
	settings: Pick<RunnerSettings, "agent" | "assistant" | "providers">,
): AgentSettings | string {
	const base = dispatch.stage === "work" ? settings.agent : settings.assistant;
	if (!base) return `no assistant agent configured for stage ${dispatch.stage}`;
	const provider = dispatch.env.provider ?? base.provider;
	if (dispatch.env.provider) {
		const name = dispatch.env.provider.split("/")[0] as string;
		if (!settings.providers.includes(name))
			return `provider ${name} is not offered by this runner`;
	}
	return { ...base, ...(provider ? { provider } : {}) };
}

/**
 * Check everything a dispatch needs, then run its setup commands. On success
 * the agent may start in `cwd`.
 */
export async function checkDispatch(
	dispatch: Pick<Dispatch, "stage" | "env">,
	settings: RunnerSettings,
	deps: CheckDeps = {},
): Promise<CheckResult> {
	const env = dispatch.env;
	const agent = agentFor(dispatch, settings);
	if (typeof agent === "string") return { ok: false, reason: agent };

	const unmet: string[] = [];
	for (const req of env.requires ?? []) {
		const why = await checkRequirement(req, settings, deps);
		if (why) unmet.push(why);
	}
	if (unmet.length) return { ok: false, reason: unmet.join("; ") };

	let cwd: string | undefined;
	if (env.repo) {
		cwd = repoDir(settings.repos, env.repo);
		if (!cwd) return { ok: false, reason: `no local checkout for ${env.repo}` };
		if (!(await (deps.isGitDir ?? gitDir)(cwd)))
			return { ok: false, reason: `checkout of ${env.repo} is not a git dir` };
	} else {
		cwd = settings.workdir;
		if (!cwd) return { ok: false, reason: "runner has no workdir" };
	}
	if (!existsSync(cwd) || !statSync(cwd).isDirectory())
		return { ok: false, reason: "the runner's working directory is missing" };

	const procEnv = deps.env ?? process.env;
	const missing = (env.secrets ?? []).filter((name) => !procEnv[name]);
	if (missing.length)
		return { ok: false, reason: `secrets not set: ${missing.join(", ")}` };

	const setup = env.setup ?? [];
	if (setup.length && !settings.allowSetup)
		return { ok: false, reason: "setup commands are off on this runner" };
	for (const cmd of setup) {
		const res = await (deps.sh ?? runSetup)(cmd, cwd);
		if (res.code !== 0)
			return {
				ok: false,
				reason: `setup failed (exit ${res.code}): ${cmd}\n${res.tail}`,
			};
	}
	return { ok: true, cwd, agent };
}
