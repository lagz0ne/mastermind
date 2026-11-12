/**
 * `mastermind-runner env test <dir>` (mm-210.67): run an environment end to
 * end WITHOUT a task, on the same code path a task uses (box/run.ts runInBox
 * with devcontainer.ts prepareBox): access check, fetch, devcontainer build,
 * box, clone, lifecycle commands, check, both network phases, and with
 * --deep a probe agent; the box is deleted. Each step prints PASS or FAIL
 * with the fix. Nothing is pushed (output none).
 *
 * Prior art: `devcontainer up` (build and start from the local config) and
 * nektos/act (run the CI definition locally before pushing).
 *
 * The box clones the repo from its `origin` at the current branch (the box
 * cannot see this directory); the local devcontainer.json is used as is, so an
 * edit is tested before it is committed. Code changes must be pushed first.
 */
import { relative } from "node:path";
import type { DispatchEnv } from "@mastermind/core";
import { type HostRun, hostRun, prepareBox } from "./box/devcontainer.ts";
import type { BoxDriver } from "./box/driver.ts";
import { boxDockerPath } from "./box/launcher.ts";
import { type BoxTask, runInBox } from "./box/run.ts";
import type { AgentSettings } from "./config.ts";
import { PROBE_PROMPT } from "./doctor.ts";
import { findLocalConfig, validateDevcontainer } from "./env.ts";
import {
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
} from "./github.ts";
import { ANTHROPIC_KEY, CLAUDE_OAUTH } from "./onboard-credentials.ts";
import { resolveSecrets } from "./secrets/needs.ts";

export type EnvTestStep = {
	step: string;
	ok: boolean;
	detail: string;
	fix?: string;
};

/** Git credential names the runner uses (box/output.ts), plus the GitHub App. */
const GIT_NAMES = [
	"GIT_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GIT_SSH_KEY",
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
];

export type EnvTestInput = {
	dir: string;
	/** Branch, tag or commit; default: the current branch. */
	ref?: string;
	deep: boolean;
	agent: AgentSettings;
	defaultImage: string;
	env: Record<string, string | undefined>;
	loadSecrets: () => Promise<Record<string, string>>;
	/** The box engine (made by the caller: onboard-box findEngine). */
	driver: BoxDriver;
	emit: (s: EnvTestStep) => void;
	/** Git on this machine (tests). */
	run?: HostRun;
	/** The devcontainer CLI command (tests). */
	cli?: { cmd: string[]; env: Record<string, string> };
	signal?: AbortSignal;
};

/** The fix for a failed box step, from its message. */
export function fixFor(problem: string): string {
	const p = problem.toLowerCase();
	if (/no access|could not read|authentication|permission to/.test(p))
		return "give this runner read access to the repo: install the GitHub App on it (mastermind-runner onboard --git app) or a token with Contents: read (mastermind-runner secrets set GITHUB_TOKEN)";
	if (/ref missing|couldn't find remote ref|not found/.test(p))
		return "push the branch first (git push -u origin HEAD), or pass --ref <branch>";
	if (/missing secrets/.test(p))
		return "store each one: mastermind-runner secrets set <NAME>";
	if (/network/.test(p) && /resolve|connect|timed out/.test(p))
		return "check the network of this machine (DNS, proxy) and try again";
	if (/check `/.test(p))
		return "the check command failed in the box: fix it in customizations.mastermind.check, or fix the code it checks";
	if (/setup `|lifecycle|oncreate|postcreate|updatecontent|poststart/.test(p))
		return "a lifecycle command failed in the box: run it in a dev container (devcontainer up --workspace-folder .) and fix it";
	if (/devcontainer|build|dockerfile|feature/.test(p))
		return "the build failed: run devcontainer build --workspace-folder . on this machine for the full output";
	if (/agent host|paseo|output schema|not json/.test(p))
		return "the probe agent did not answer: mastermind-runner onboard (Claude login), then env test --deep again";
	if (/allow|proxy/.test(p))
		return "check customizations.mastermind.network (hosts the agent may reach)";
	return "see the line above; run env test again after the fix";
}

async function git(
	run: HostRun,
	dir: string,
	args: string[],
): Promise<string | null> {
	const r = await run(["git", "-C", dir, ...args]);
	return r.code === 0 ? r.stdout.trim() : null;
}

/** Run the test; true when every step passed. */
export async function envTest(i: EnvTestInput): Promise<boolean> {
	const run = i.run ?? hostRun;
	const pass = (step: string, detail: string) =>
		i.emit({ step, ok: true, detail });
	const fail = (step: string, detail: string, fix: string) => {
		i.emit({ step, ok: false, detail, fix });
		return false;
	};

	// 1. The config on this disk, checked as the runner will use it.
	const path = await findLocalConfig(i.dir);
	if (!path)
		return fail(
			"config",
			`no .devcontainer/devcontainer.json or .devcontainer.json in ${i.dir}`,
			`mastermind-runner env init ${i.dir}`,
		);
	const text = await Bun.file(path).text();
	const v = validateDevcontainer(text, path);
	if (!v.ok) return fail("config", v.errors.join("; "), `fix ${path}`);
	pass(
		"config",
		`${relative(i.dir, path)} is valid${v.warnings.length ? ` (${v.warnings.join("; ")})` : ""}`,
	);

	// 2. Where the box clones from.
	const repo = await git(run, i.dir, ["remote", "get-url", "origin"]);
	if (!repo)
		return fail(
			"repo",
			"this directory has no git remote origin (the box clones from it)",
			"git remote add origin <url>, then push",
		);
	let ref = i.ref;
	if (!ref) {
		const branch = await git(run, i.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
		ref =
			branch && branch !== "HEAD"
				? branch
				: ((await git(run, i.dir, ["rev-parse", "HEAD"])) ?? "");
	}
	const notes: string[] = [];
	const ahead = await git(run, i.dir, ["rev-list", "--count", "@{u}..HEAD"]);
	if (ahead && ahead !== "0")
		notes.push(
			`${ahead} local commits are not pushed: the box does not see them`,
		);
	const dirty = (await git(run, i.dir, ["status", "--porcelain"])) ?? "";
	const changed = dirty
		.split("\n")
		.filter(Boolean)
		.filter((l) => !l.endsWith(relative(i.dir, path)));
	if (changed.length)
		notes.push(
			`${changed.length} changed files are not in the box (only devcontainer.json is used from this disk)`,
		);
	pass(
		"repo",
		`${repo} at ${ref}${notes.length ? `; ${notes.join("; ")}` : ""}`,
	);

	// 3. Secrets: the file's required names, the git credential, the Claude login.
	let stored: Record<string, string>;
	try {
		stored = await i.loadSecrets();
	} catch (error) {
		return fail(
			"secrets",
			error instanceof Error ? error.message : String(error),
			"fix the secrets file, then run env test again",
		);
	}
	const required = v.block.secrets ?? [];
	const optional = [
		...GIT_NAMES,
		...(i.deep ? [CLAUDE_OAUTH, ANTHROPIC_KEY] : []),
	].filter((n) => stored[n] || i.env[n]);
	const { values, missing } = await resolveSecrets(
		[...new Set([...required, ...optional])],
		{ store: stored, env: i.env },
	);
	if (missing.length)
		return fail(
			"secrets",
			`missing: ${missing.join(", ")}`,
			missing.map((m) => `mastermind-runner secrets set ${m}`).join("; "),
		);
	if (i.deep && !stored[CLAUDE_OAUTH] && !stored[ANTHROPIC_KEY])
		return fail(
			"secrets",
			"no Claude login on this machine for the probe agent",
			"mastermind-runner onboard (Claude login), or secrets set ANTHROPIC_API_KEY",
		);
	pass(
		"secrets",
		`${required.length ? `${required.join(", ")} present` : "none required by the file"}; git credential ${GIT_NAMES.some((n) => values[n]) ? "present" : "none (public repos only)"}`,
	);

	// 4. The task path: prepare (access, fetch, build) and the box.
	let engine: string;
	try {
		engine = await i.driver.ping();
	} catch (error) {
		return fail(
			"box engine",
			error instanceof Error ? error.message : String(error),
			"mastermind-runner onboard (it finds the engine or names the fix)",
		);
	}
	const local = path.endsWith(".devcontainer/devcontainer.json");
	const env: DispatchEnv = {
		name: "env-test",
		repo,
		ref,
		requires: [],
		secrets: Object.keys(values),
		...(v.block.check ? { check: v.block.check } : {}),
		...(v.block.network ? { network: v.block.network } : {}),
		...(v.block.instructions ? { instructions: v.block.instructions } : {}),
		output: { kind: "none" },
		// The file from this disk: an edit is tested before the commit.
		devcontainer: local
			? { config: text }
			: { configPath: relative(i.dir, path) },
	};
	const id = `envtest-${Date.now().toString(36)}`;
	const task: BoxTask = {
		executionId: id,
		beadId: "env-test",
		runnerId: "env-test",
		title: "env test",
		prompt: PROBE_PROMPT,
		env,
		agent: { ...i.agent, mode: i.agent.mode ?? "bypassPermissions" },
		secrets: values,
	};
	const dockerPath = boxDockerPath(i.env, engine);
	try {
		const r = await runInBox(
			task,
			{
				driver: i.driver,
				defaultImage: i.defaultImage,
				onStep: (line) => pass("box", line),
				prepare: (t, step, signal) =>
					prepareBox(
						t,
						{
							defaultImage: i.defaultImage,
							dockerPath,
							env: i.env,
							...(i.run ? { run: i.run } : {}),
							...(i.cli ? { cli: i.cli } : {}),
							lookupSecrets: async (names) =>
								resolveSecrets(names, { store: stored, env: i.env }),
						},
						step,
						signal,
					),
				...(i.deep
					? {}
					: {
							// No agent: a fixed answer, so the box steps are the test.
							agentCommand: () => [
								"sh",
								"-c",
								`printf '%s' '{"status":"done","summary":"no agent (env test --deep runs one)"}'`,
							],
							readyCommand: null,
						}),
			},
			i.signal ?? new AbortController().signal,
		);
		if (r.status !== "done")
			return fail(
				"agent",
				`the probe agent says: ${r.summary}`,
				fixFor("probe agent paseo"),
			);
		pass(i.deep ? "agent" : "result", r.summary);
		return true;
	} catch (error) {
		const m = error instanceof Error ? error.message : String(error);
		return fail("box", m, fixFor(m));
	}
}
