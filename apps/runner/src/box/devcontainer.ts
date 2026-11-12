/**
 * The box from the repo's devcontainer.json (bead mm-210.62), on the RUNNER
 * machine, before any box is made:
 *
 *   1. access check   git ls-remote with the environment's git credential only
 *                     (not this machine's own git or SSH setup): clear reasons
 *   2. fetch          shallow, blobless fetch at ref into a temp dir
 *   3. find config    the environment's own definition, else configPath, else
 *                     .devcontainer/devcontainer.json, else .devcontainer.json,
 *                     else the default box image
 *   4. clean          drop the fields that reach the HOST (initializeCommand,
 *                     runArgs, mounts, privileged, ...); refuse Docker Compose
 *   5. build          the official CLI: `devcontainer build` (image or
 *                     build.dockerfile + features), then the Mastermind layer
 *                     (Paseo daemon + Claude Code from the default box image),
 *                     cached by the config hash
 *   6. metadata       the image's `devcontainer.metadata` label (spec: merged
 *                     config of the features and the file): lifecycle commands,
 *                     the user, remoteEnv
 *
 * The box itself is still made, filled and deleted by the box driver (run.ts):
 * limits, network and mounts stay ours. initializeCommand (spec: runs on the
 * host) never runs unless the environment lists it in `allowHost`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { DevcontainerSettings, DispatchEnv } from "@mastermind/core";
import type { ExecResult } from "./driver.ts";
import { GIT_SSH_KEY_SECRET, gitTokenName, redact } from "./output.ts";

/** The pinned official CLI (npm @devcontainers/cli). */
export const DEVCONTAINER_CLI_VERSION = "0.90.0";
/** Changes when the Mastermind layer changes: part of the image cache key. */
const LAYER_VERSION = 1;
/** Local image names of devcontainer boxes: `mastermind-dc:<key>`. */
export const DC_IMAGE_REPO = "mastermind-dc";

/** Fields that reach the host machine; removed before the build. */
export const HOST_FIELDS = [
	"initializeCommand",
	"runArgs",
	"mounts",
	"workspaceMount",
	"privileged",
	"capAdd",
	"securityOpt",
	"appPort",
] as const;
/** Fields of features in the image metadata the box driver does not apply. */
const IGNORED_META = [
	"privileged",
	"capAdd",
	"securityOpt",
	"mounts",
	"entrypoint",
] as const;
/** Lifecycle commands run in the box after the checkout, in this order. */
export const LIFECYCLE = [
	"onCreateCommand",
	"updateContentCommand",
	"postCreateCommand",
	"postStartCommand",
] as const;

export class DevcontainerError extends Error {
	override name = "DevcontainerError";
}

export type HostRun = (
	cmd: string[],
	o?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Run a command on this machine; never throws for a non-zero exit. */
export const hostRun: HostRun = async (cmd, o = {}) => {
	const p = Bun.spawn(cmd, {
		...(o.cwd ? { cwd: o.cwd } : {}),
		env: { ...process.env, ...o.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		...(o.signal ? { signal: o.signal } : {}),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, stdout, stderr };
};

// --- 1. access check -------------------------------------------------------

/**
 * Environment for git on this machine: only the environment's credential.
 * The machine's own git config, credential helpers, SSH agent and keys are
 * not used (they would hide a missing credential). Values only in env vars
 * of the git process, never in argv. `dir` holds the key file and known_hosts.
 */
export async function gitEnv(
	secrets: Record<string, string>,
	dir: string,
): Promise<Record<string, string>> {
	const env: Record<string, string> = {
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		GCM_INTERACTIVE: "never",
	};
	let identity = "-o IdentityFile=none";
	const key = secrets[GIT_SSH_KEY_SECRET];
	if (key) {
		const path = join(dir, "git-key");
		await writeFile(path, key.endsWith("\n") ? key : `${key}\n`, {
			mode: 0o600,
		});
		identity = `-o IdentityFile=${path}`;
	}
	env.GIT_SSH_COMMAND = `ssh -F /dev/null -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes ${identity} -o UserKnownHostsFile=${join(dir, "known_hosts")} -o StrictHostKeyChecking=accept-new`;
	const name = gitTokenName(secrets);
	const token = name ? secrets[name] : undefined;
	if (token) {
		env.MM_GIT_TOKEN = token;
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = "credential.helper";
		env.GIT_CONFIG_VALUE_0 =
			'!f() { test "$1" = get || exit 0; echo username=x-access-token; printf "password=%s\\n" "$MM_GIT_TOKEN"; }; f';
	}
	return env;
}

export type AccessResult =
	| { ok: true }
	| {
			ok: false;
			kind: "no-access" | "ref-missing" | "network" | "error";
			reason: string;
	  };

const SHA = /^[0-9a-f]{7,40}$/i;

/** The credential an access check used, for the reason text. */
function credentialName(secrets: Record<string, string>): string | null {
	const t = gitTokenName(secrets);
	if (t && secrets[t]) return t;
	return secrets[GIT_SSH_KEY_SECRET] ? GIT_SSH_KEY_SECRET : null;
}

/** Why a git command against the remote failed, in one line. */
export function classifyGitError(
	r: ExecResult,
	repo: string,
	secrets: Record<string, string>,
): Extract<AccessResult, { ok: false }> {
	const text = redact(`${r.stderr}${r.stdout}`, secrets).trim();
	const cred = credentialName(secrets);
	if (
		/could not resolve host|network is unreachable|connection (timed out|refused)|operation timed out|temporary failure in name resolution/i.test(
			text,
		)
	)
		return {
			ok: false,
			kind: "network",
			reason: `repo ${repo} is not reachable from this runner: ${lastLine(text)}`,
		};
	if (
		/could not read (username|password)|terminal prompts disabled|authentication failed|permission denied|repository not found|not found|403|401|invalid username|could not read from remote|does not appear to be a git repository/i.test(
			text,
		)
	)
		return {
			ok: false,
			kind: "no-access",
			reason: cred
				? `no access to ${repo} with ${cred}: the repo does not exist or ${cred} cannot read it (${lastLine(text)})`
				: `no access to ${repo}: the repo is private or does not exist, and the environment has no git credential (add GIT_TOKEN or ${GIT_SSH_KEY_SECRET} to its secrets)`,
		};
	return {
		ok: false,
		kind: "error",
		reason: `git (${repo}) exited ${r.code}: ${lastLine(text)}`,
	};
}

function lastLine(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim());
	return (lines.at(-1) ?? "").slice(0, 300);
}

/**
 * Can this runner read `repo` at `ref` with the environment's credential?
 * `git ls-remote --exit-code` (exit 2: no such ref); no clone. A commit id
 * cannot be listed: then only the repo is checked.
 */
export async function checkAccess(
	repo: string,
	ref: string,
	secrets: Record<string, string>,
	run: HostRun = hostRun,
	signal?: AbortSignal,
): Promise<AccessResult> {
	const dir = await mkdtemp(join(tmpdir(), "mm-access-"));
	try {
		const env = await gitEnv(secrets, dir);
		const named = ref && ref !== "HEAD" && !SHA.test(ref) ? ref : "HEAD";
		let r: ExecResult;
		try {
			r = await run(["git", "ls-remote", "--exit-code", repo, named], {
				cwd: dir,
				env,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			return {
				ok: false,
				kind: "error",
				reason: `git on the runner machine: ${error instanceof Error ? error.message : error} (install git)`,
			};
		}
		if (r.code === 0) return { ok: true };
		if (r.code === 2)
			return {
				ok: false,
				kind: "ref-missing",
				reason: `ref ${named} is not in ${repo} (no branch or tag of that name)`,
			};
		return classifyGitError(r, repo, secrets);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- 3. find the config ----------------------------------------------------

/**
 * The config file to use, from the repo's file list (paths from the root).
 * `configPath`: a path to a .json file, or the name of a folder under
 * .devcontainer/. Else the spec's lookup: .devcontainer/devcontainer.json,
 * then .devcontainer.json. Null: none (the default box image).
 */
export function findConfig(
	paths: readonly string[],
	configPath?: string,
): string | null {
	const have = new Set(paths);
	if (configPath) {
		const p = configPath.replace(/^\.?\//, "").replace(/\/$/, "");
		const want = p.endsWith(".json")
			? p
			: `.devcontainer/${p.replace(/^\.devcontainer\//, "")}/devcontainer.json`;
		if (!have.has(want))
			throw new DevcontainerError(
				`configPath ${configPath}: ${want} is not in the repo`,
			);
		return want;
	}
	for (const p of [".devcontainer/devcontainer.json", ".devcontainer.json"])
		if (have.has(p)) return p;
	return null;
}

/** Configs in .devcontainer/<name>/ that need a configPath to be used. */
export function namedConfigs(paths: readonly string[]): string[] {
	return paths
		.map((p) => /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(p)?.[1])
		.filter((n): n is string => !!n);
}

// --- 4. clean ---------------------------------------------------------------

export type DevcontainerConfig = Record<string, unknown>;

export type Cleaned = {
	config: DevcontainerConfig;
	/** Removed field names, for the ticket. */
	removed: string[];
	/** initializeCommand, when the environment allows it on the host. */
	initializeCommand?: unknown;
	/** Secret names: top-level `secrets` (Codespaces: recommended, optional). */
	recommendedSecrets: string[];
	/** customizations.mastermind.secrets: required. */
	requiredSecrets: string[];
	/** customizations.mastermind.instructions. */
	instructions?: string;
};

/** Parse devcontainer.json (JSON with comments and trailing commas). */
export function parseConfig(text: string, where: string): DevcontainerConfig {
	let v: unknown;
	try {
		v = Bun.JSONC.parse(text);
	} catch (error) {
		throw new DevcontainerError(
			`${where}: not valid JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new DevcontainerError(`${where}: not a JSON object`);
	return v as DevcontainerConfig;
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/**
 * Remove what reaches the host; refuse Docker Compose. `allowHost`: field
 * names the environment allows (only initializeCommand has an effect: the
 * runner runs it on this machine itself; the box driver never applies the
 * container fields).
 */
export function cleanConfig(
	config: DevcontainerConfig,
	allowHost: readonly string[] = [],
): Cleaned {
	if ("dockerComposeFile" in config)
		throw new DevcontainerError(
			"dockerComposeFile: Docker Compose is not supported in a box; use image or build.dockerfile",
		);
	if (!("image" in config) && !("build" in config))
		throw new DevcontainerError(
			"devcontainer.json has neither image nor build.dockerfile",
		);
	const out: DevcontainerConfig = { ...config };
	const removed: string[] = [];
	let initializeCommand: unknown;
	for (const f of HOST_FIELDS) {
		if (!(f in out)) continue;
		if (f === "initializeCommand" && allowHost.includes(f))
			initializeCommand = out[f];
		else removed.push(f);
		delete out[f];
	}
	const build = out.build;
	if (build && typeof build === "object" && "options" in build) {
		const { options: _o, ...rest } = build as Record<string, unknown>;
		out.build = rest;
		removed.push("build.options");
	}
	const top = out.secrets;
	const recommendedSecrets =
		top && typeof top === "object" && !Array.isArray(top)
			? Object.keys(top)
			: [];
	const mm = (out.customizations as Record<string, unknown> | undefined)
		?.mastermind as Record<string, unknown> | undefined;
	const instructions =
		typeof mm?.instructions === "string" && mm.instructions.trim()
			? mm.instructions
			: undefined;
	return {
		config: out,
		removed,
		...(initializeCommand !== undefined ? { initializeCommand } : {}),
		recommendedSecrets,
		requiredSecrets: strings(mm?.secrets),
		...(instructions ? { instructions } : {}),
	};
}

// --- 6. image metadata -------------------------------------------------------

export type LifecycleStep = { what: string; cmd: string[] };

/** A lifecycle command (string, array, or object of named ones) as argv lists. */
function commands(c: unknown): { key?: string; cmd: string[] }[] {
	if (typeof c === "string")
		return c.trim() ? [{ cmd: ["/bin/sh", "-c", c] }] : [];
	if (Array.isArray(c)) {
		const argv = strings(c);
		return argv.length ? [{ cmd: argv }] : [];
	}
	if (c && typeof c === "object")
		return Object.entries(c).flatMap(([key, v]) =>
			commands(v).map((x) => ({ key, cmd: x.cmd })),
		);
	return [];
}

/**
 * The lifecycle commands of the merged metadata, in the order of the spec:
 * every onCreateCommand (features first, the file last), then every
 * updateContentCommand, postCreateCommand, postStartCommand. Named commands
 * of an object run one after the other.
 */
export function lifecycleSteps(meta: readonly DevcontainerConfig[]) {
	const steps: LifecycleStep[] = [];
	for (const hook of LIFECYCLE)
		for (const entry of meta) {
			const origin =
				typeof entry.id === "string" ? entry.id : "devcontainer.json";
			for (const c of commands(entry[hook]))
				steps.push({
					what: `${hook} (${origin}${c.key ? `: ${c.key}` : ""})`,
					cmd: c.cmd,
				});
		}
	return steps;
}

/** The user in the box: remoteUser, else containerUser, else the image's. */
export function metadataUser(
	meta: readonly DevcontainerConfig[],
	imageUser: string,
): string {
	let remote: string | undefined;
	let container: string | undefined;
	for (const m of meta) {
		if (typeof m.remoteUser === "string") remote = m.remoteUser;
		if (typeof m.containerUser === "string") container = m.containerUser;
	}
	return remote ?? container ?? (imageUser || "root");
}

/** remoteEnv of the metadata, without values that need `${...}` substitution. */
export function metadataEnv(meta: readonly DevcontainerConfig[]) {
	const env: Record<string, string> = {};
	const skipped: string[] = [];
	for (const m of meta) {
		const r = m.remoteEnv;
		if (!r || typeof r !== "object") continue;
		for (const [k, v] of Object.entries(r)) {
			if (typeof v !== "string") continue;
			if (v.includes("${")) skipped.push(k);
			else env[k] = v;
		}
	}
	return { env, skipped };
}

/** Feature settings the box driver does not apply, as `field (feature)`. */
export function ignoredMetadata(meta: readonly DevcontainerConfig[]): string[] {
	const out: string[] = [];
	for (const m of meta)
		for (const f of IGNORED_META) {
			const v = m[f];
			if (v === undefined || v === false || (Array.isArray(v) && !v.length))
				continue;
			out.push(
				`${f} (${typeof m.id === "string" ? m.id : "devcontainer.json"})`,
			);
		}
	return out;
}

// --- 5. the Mastermind layer --------------------------------------------------

const MM = "/opt/mastermind";
const NODE_MODULES = "/usr/local/lib/node_modules";

/**
 * The box entry of a devcontainer image: the Paseo daemon as the dev
 * container's user, with the runtime from the default box image.
 */
export const BOX_ENTRYPOINT = `#!/bin/sh
# Mastermind box entry (devcontainer image): the Paseo daemon as MM_BOX_USER.
set -e
if [ "$#" -gt 0 ]; then exec "$@"; fi
u="\${MM_BOX_USER:-root}"
home="$(awk -F: -v u="$u" '$1==u {print $6}' /etc/passwd)"
[ -n "$home" ] || home=/root
export HOME="$home"
export PASEO_HOME="\${PASEO_HOME:-$home/.paseo}"
export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$home/.claude}"
mkdir -p "$PASEO_HOME" "$CLAUDE_CONFIG_DIR"
[ -f "$CLAUDE_CONFIG_DIR/.claude.json" ] || printf '{"hasCompletedOnboarding":true}\\n' > "$CLAUDE_CONFIG_DIR/.claude.json"
entry="$(sed 's#^${NODE_MODULES}#${MM}/node/lib/node_modules#' ${MM}/paseo-server-entry)"
if [ "$(id -u)" = 0 ] && [ "$u" != root ] && [ "$u" != 0 ]; then
	chown -R "$u" "$PASEO_HOME" "$CLAUDE_CONFIG_DIR"
	exec ${MM}/bin/gosu "$u" ${MM}/node/bin/node "$entry"
fi
exec ${MM}/node/bin/node "$entry"
`;

/**
 * Dockerfile of the Mastermind layer on top of the devcontainer image: node,
 * Paseo and Claude Code copied from the default box image into /opt/mastermind
 * (the image's own node stays first on PATH), the entry above.
 */
export function layerDockerfile(base: string, from: string, user: string) {
	const lines = [
		`FROM ${from} AS mastermind`,
		`FROM ${base}`,
		"USER root",
		`COPY --from=mastermind /usr/local/bin/node ${MM}/node/bin/node`,
		`COPY --from=mastermind ${NODE_MODULES}/@getpaseo ${MM}/node/lib/node_modules/@getpaseo`,
		`COPY --from=mastermind ${NODE_MODULES}/@anthropic-ai ${MM}/node/lib/node_modules/@anthropic-ai`,
		`COPY --from=mastermind /usr/sbin/gosu ${MM}/bin/gosu`,
		`COPY --from=mastermind /etc/paseo-server-entry ${MM}/paseo-server-entry`,
		`COPY box-entrypoint ${MM}/bin/box-entrypoint`,
		`RUN printf '#!/bin/sh\\nexec ${MM}/node/bin/node ${MM}/node/lib/node_modules/@getpaseo/cli/bin/paseo "$@"\\n' > ${MM}/bin/paseo \\`,
		`	&& ln -s ${MM}/node/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe ${MM}/bin/claude \\`,
		`	&& chmod 755 ${MM}/bin/paseo ${MM}/bin/box-entrypoint`,
		`ENV PATH=${MM}/bin:\${PATH}:${MM}/node/bin \\`,
		`	MM_BOX_USER=${JSON.stringify(user)} \\`,
		"	DISABLE_AUTOUPDATER=1 \\",
		"	PASEO_DICTATION_ENABLED=false \\",
		"	PASEO_VOICE_MODE_ENABLED=false \\",
		"	PASEO_WEB_UI_ENABLED=false",
		`ENTRYPOINT ["${MM}/bin/box-entrypoint"]`,
		"CMD []",
	];
	return `${lines.join("\n")}\n`;
}

// --- the CLI -------------------------------------------------------------------

/**
 * How to start the devcontainer CLI. MM_DEVCONTAINER_CLI (a command line,
 * for example `devcontainer`) when set; else the pinned npm package through
 * the runner's own Bun (`BUN_BE_BUN=1 <runner> x --bun @devcontainers/cli@...`):
 * no Node and no install needed on the runner machine.
 */
export function devcontainerCli(
	env: Record<string, string | undefined> = process.env,
	execPath: string = process.execPath,
): { cmd: string[]; env: Record<string, string> } {
	const own = env.MM_DEVCONTAINER_CLI?.trim();
	if (own) return { cmd: own.split(/\s+/), env: {} };
	return {
		cmd: [
			execPath,
			"x",
			"--bun",
			`@devcontainers/cli@${DEVCONTAINER_CLI_VERSION}`,
		],
		env: { BUN_BE_BUN: "1" },
	};
}

/** The message of a failed `devcontainer build --log-format json`. */
export function cliFailure(r: ExecResult): string {
	const lines = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim());
	const texts: string[] = [];
	for (const l of lines) {
		try {
			const j = JSON.parse(l) as {
				outcome?: string;
				message?: string;
				description?: string;
				text?: string;
			};
			if (j.outcome === "error")
				return [j.message, j.description].filter(Boolean).join(": ");
			if (j.text) texts.push(j.text.trim());
		} catch {
			texts.push(l.trim());
		}
	}
	return texts.join("\n").slice(-800) || `exited ${r.code}`;
}

// --- prepare: all of the above for one task ------------------------------------

export type PreparedBox = {
	/** The image to start the box from. */
	image: string;
	/** The user for every step in the box. */
	user: string;
	/** Run in the checkout after the clone, before the environment's setup. */
	lifecycle: LifecycleStep[];
	/** Box environment from remoteEnv (no secret values). */
	env: Record<string, string>;
	/** More secret values (named in devcontainer.json). */
	secrets: Record<string, string>;
	/** Text for the prompt (customizations.mastermind.instructions). */
	instructions?: string;
};

export type PrepareDeps = {
	/** The default box image: source of the Mastermind layer. */
	defaultImage: string;
	/** Docker CLI for the devcontainer CLI and the layer (`docker` or `podman`). */
	dockerPath: string;
	/** Secret values by name from this machine; missing names listed. */
	lookupSecrets?: (
		names: string[],
	) => Promise<{ values: Record<string, string>; missing: string[] }>;
	run?: HostRun;
	env?: Record<string, string | undefined>;
	/** Command of the devcontainer CLI; default {@link devcontainerCli}. */
	cli?: { cmd: string[]; env: Record<string, string> };
};

export type PrepareTask = {
	beadId: string;
	env: Pick<DispatchEnv, "repo" | "ref" | "image" | "devcontainer">;
	secrets: Record<string, string>;
};

const building = new Map<string, Promise<void>>();

/**
 * Before any box: the access check, then the devcontainer image when the
 * environment (or its repo) has a devcontainer.json. Null: no devcontainer
 * (the box uses the environment's image or the default image). Throws
 * {@link DevcontainerError} with the reason; no box was made.
 */
export async function prepareBox(
	task: PrepareTask,
	deps: PrepareDeps,
	step: (line: string) => void,
	signal?: AbortSignal,
): Promise<PreparedBox | null> {
	const run = deps.run ?? hostRun;
	const { repo, ref } = task.env;
	const dc: DevcontainerSettings | undefined = task.env.devcontainer;
	if (!repo) return null;
	const access = await checkAccess(repo, ref, task.secrets, run, signal);
	if (!access.ok) throw new DevcontainerError(access.reason);
	step(`access check: ${repo} at ${ref || "HEAD"} is readable`);
	// An environment with its own image and no devcontainer settings keeps
	// its recipe (image + tools + setup).
	if (task.env.image && !dc) return null;
	if (dc?.use === "none") return null;

	const dir = await mkdtemp(join(tmpdir(), "mm-dc-"));
	const ws = join(dir, "ws");
	const git = async (args: string[], what: string) => {
		const r = await run(["git", ...args], {
			cwd: ws,
			env: await gitEnv(task.secrets, dir),
			...(signal ? { signal } : {}),
		});
		if (r.code !== 0)
			throw new DevcontainerError(
				`${what}: ${classifyGitError(r, repo, task.secrets).reason}`,
			);
		return r.stdout;
	};
	try {
		await run(["git", "init", "-q", ws]);
		await git(["remote", "add", "origin", repo], "git remote");
		await git(
			[
				"fetch",
				"-q",
				"--depth",
				"1",
				"--filter=blob:none",
				"origin",
				ref || "HEAD",
			],
			`fetch ${ref || "HEAD"}`,
		);
		const paths = (
			await git(
				[
					"ls-tree",
					"-r",
					"--name-only",
					"FETCH_HEAD",
					"--",
					".devcontainer",
					".devcontainer.json",
				],
				"ls-tree",
			)
		)
			.split("\n")
			.filter(Boolean);

		// The config: the environment's own text, or the repo's file.
		let configPath: string;
		let text: string;
		const inline = dc?.config?.trim();
		if (inline) {
			configPath = ".devcontainer/.mastermind-env.devcontainer.json";
			text = inline;
		} else {
			const found = findConfig(paths, dc?.configPath);
			if (!found) {
				const named = namedConfigs(paths);
				step(
					named.length
						? `no devcontainer.json at the top of the repo (found ${named.map((n) => `.devcontainer/${n}/`).join(", ")}: name one in the environment's configPath): default box image`
						: "no devcontainer.json in the repo: default box image",
				);
				return null;
			}
			configPath = found;
			text = "";
		}
		// The files the build may need (Dockerfile, local features, context).
		await git(["checkout", "-q", "FETCH_HEAD"], "checkout");
		if (!inline) text = await Bun.file(join(ws, configPath)).text();
		const where = inline ? "the environment's devcontainer.json" : configPath;
		const cleaned = cleanConfig(parseConfig(text, where), dc?.allowHost ?? []);
		if (cleaned.removed.length)
			step(
				`${where}: not applied (they reach the host): ${cleaned.removed.join(", ")}`,
			);

		// Secrets named in the file: required (ours) and recommended (Codespaces).
		const extra: Record<string, string> = {};
		const wanted = [
			...new Set([...cleaned.requiredSecrets, ...cleaned.recommendedSecrets]),
		].filter((n) => !(n in task.secrets));
		if (wanted.length) {
			const got = deps.lookupSecrets
				? await deps.lookupSecrets(wanted)
				: { values: {}, missing: wanted };
			Object.assign(extra, got.values);
			const req = got.missing.filter((n) =>
				cleaned.requiredSecrets.includes(n),
			);
			if (req.length)
				throw new DevcontainerError(
					`missing secrets named in ${where} (customizations.mastermind.secrets): ${req.join(", ")} (on the runner: ${req.map((n) => `mastermind-runner secrets set ${n}`).join("; ")})`,
				);
			const rec = got.missing.filter(
				(n) => !cleaned.requiredSecrets.includes(n),
			);
			if (rec.length)
				step(`recommended secrets not set on this runner: ${rec.join(", ")}`);
		}

		const cfgDir = posix.dirname(configPath);
		const cleanPath = posix.join(cfgDir, ".mastermind.devcontainer.json");
		const cleanText = JSON.stringify(cleaned.config, null, "\t");
		await mkdir(join(ws, cfgDir), { recursive: true });
		await writeFile(join(ws, cleanPath), cleanText);
		const key = await cacheKey(
			git,
			cleanText,
			cfgDir,
			cleaned.config,
			deps.defaultImage,
		);
		const image = `${DC_IMAGE_REPO}:${key}`;

		const docker = deps.dockerPath;
		const inspect = async (ref: string) => {
			const r = await run([
				docker,
				"image",
				"inspect",
				"--format",
				"{{json .Config}}",
				ref,
			]);
			if (r.code !== 0) return null;
			return JSON.parse(r.stdout.trim()) as {
				User?: string;
				Labels?: Record<string, string> | null;
			};
		};

		let info = await inspect(image);
		if (!info) {
			const running = building.get(key);
			if (running) await running;
			else {
				const p = buildImage({
					...deps,
					run,
					ws,
					dir,
					cleanPath,
					image,
					initializeCommand: cleaned.initializeCommand,
					inspect,
					step,
					...(signal ? { signal } : {}),
				}).finally(() => building.delete(key));
				building.set(key, p);
				await p;
			}
			info = await inspect(image);
			if (!info)
				throw new DevcontainerError(`${image} is missing after the build`);
		} else step(`devcontainer image ${image} (cached)`);

		const meta = parseMetadata(info.Labels?.["devcontainer.metadata"]);
		const user = metadataUser(meta, info.User ?? "");
		const ignored = ignoredMetadata(meta);
		if (ignored.length)
			step(
				`not applied in the box (the box driver owns them): ${ignored.join(", ")}`,
			);
		const { env, skipped } = metadataEnv(meta);
		if (skipped.length)
			step(`remoteEnv with \${...} not applied: ${skipped.join(", ")}`);
		return {
			image,
			user,
			lifecycle: lifecycleSteps(meta),
			env,
			secrets: extra,
			...(cleaned.instructions ? { instructions: cleaned.instructions } : {}),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The image cache key: the cleaned config, the trees it builds from, versions. */
async function cacheKey(
	git: (args: string[], what: string) => Promise<string>,
	cleanText: string,
	cfgDir: string,
	config: DevcontainerConfig,
	from: string,
): Promise<string> {
	const trees = new Set([cfgDir]);
	const build = config.build as { context?: unknown } | undefined;
	if (build && typeof build === "object")
		trees.add(
			posix.normalize(
				posix.join(
					cfgDir,
					typeof build.context === "string" ? build.context : ".",
				),
			),
		);
	const ids: string[] = [];
	for (const t of [...trees].sort()) {
		const spec = t === "." ? "FETCH_HEAD^{tree}" : `FETCH_HEAD:${t}`;
		// A folder that is not in the repo (the environment's own config): none.
		const id = await git(
			["rev-parse", "--verify", "-q", spec],
			"rev-parse",
		).catch(() => "none");
		ids.push(`${t}=${id.trim()}`);
	}
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				cli: DEVCONTAINER_CLI_VERSION,
				layer: LAYER_VERSION,
				from,
				config: cleanText,
				trees: ids,
			}),
		)
		.digest("hex")
		.slice(0, 16);
}

function parseMetadata(label: string | undefined): DevcontainerConfig[] {
	if (!label) return [];
	try {
		const v = JSON.parse(label) as unknown;
		return (Array.isArray(v) ? v : [v]).filter(
			(m): m is DevcontainerConfig => !!m && typeof m === "object",
		);
	} catch {
		return [];
	}
}

async function buildImage(o: {
	run: HostRun;
	ws: string;
	dir: string;
	cleanPath: string;
	image: string;
	initializeCommand?: unknown;
	defaultImage: string;
	dockerPath: string;
	env?: Record<string, string | undefined>;
	cli?: { cmd: string[]; env: Record<string, string> };
	inspect: (ref: string) => Promise<{
		User?: string;
		Labels?: Record<string, string> | null;
	} | null>;
	step: (line: string) => void;
	signal?: AbortSignal;
}): Promise<void> {
	const sig = o.signal ? { signal: o.signal } : {};
	if (o.initializeCommand !== undefined) {
		for (const c of commands(o.initializeCommand)) {
			o.step(
				`initializeCommand on the runner machine (allowed by the environment): ${c.cmd.join(" ")}`,
			);
			const r = await o.run(c.cmd, { cwd: o.ws, ...sig });
			if (r.code !== 0)
				throw new DevcontainerError(
					`initializeCommand exited ${r.code}: ${`${r.stdout}${r.stderr}`.trim().slice(-500)}`,
				);
		}
	}
	const cli = o.cli ?? devcontainerCli(o.env);
	const base = `${o.image}-base`;
	o.step(
		`building the devcontainer image (devcontainer CLI ${o.cli ? o.cli.cmd.join(" ") : DEVCONTAINER_CLI_VERSION})`,
	);
	const t0 = Date.now();
	const r = await o.run(
		[
			...cli.cmd,
			"build",
			"--workspace-folder",
			o.ws,
			"--config",
			join(o.ws, o.cleanPath),
			"--image-name",
			base,
			"--docker-path",
			o.dockerPath,
			"--log-format",
			"json",
		],
		{ cwd: o.ws, env: cli.env, ...sig },
	);
	if (r.code !== 0)
		throw new DevcontainerError(`devcontainer build failed: ${cliFailure(r)}`);
	const baseInfo = await o.inspect(base);
	if (!baseInfo)
		throw new DevcontainerError(`devcontainer build: ${base} is missing`);
	const user = metadataUser(
		parseMetadata(baseInfo.Labels?.["devcontainer.metadata"]),
		baseInfo.User ?? "",
	);
	const ctx = join(o.dir, "layer");
	await Bun.write(
		join(ctx, "Dockerfile"),
		layerDockerfile(base, o.defaultImage, user),
	);
	await Bun.write(join(ctx, "box-entrypoint"), BOX_ENTRYPOINT);
	const l = await o.run([o.dockerPath, "build", "-q", "-t", o.image, ctx], sig);
	if (l.code !== 0)
		throw new DevcontainerError(
			`Mastermind layer on ${base} failed: ${`${l.stdout}${l.stderr}`.trim().slice(-800)}`,
		);
	o.step(
		`devcontainer image ${o.image} built in ${((Date.now() - t0) / 1000).toFixed(0)} s (user ${user})`,
	);
}
