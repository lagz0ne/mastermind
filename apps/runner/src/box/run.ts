/**
 * One task in one throwaway box (docs/design/box.html):
 *
 *   prepare (devcontainer.ts, on this machine: git access check; the repo's or
 *   the environment's devcontainer.json built by the devcontainer CLI)
 *   -> code by mount (default, workspace.ts, mm-210.83): this machine fetches
 *   the repo into its clean clone and makes a work copy for /workspace
 *   -> ensure image (cached by recipe hash) -> create box (limits, network,
 *   labels, the work copy mounted) -> with MM_BOX_CODE=clone instead: clone
 *   repo at ref into /workspace (the git credential only in the env of that
 *   one command) -> secrets as env and files (never the git credential)
 *   -> devcontainer lifecycle commands (onCreate, updateContent, postCreate,
 *   postStart) -> setup, then check (fail: the reason and the output tail)
 *   -> network phase agent: an allow list drops the registries and the repo
 *   host it had for setup (proxy.ts networkPhases, mm-210.63)
 *   -> the item's input files into INPUTS_DIR (files.ts, mm-210.60)
 *   -> wait for the Paseo daemon in the box -> `paseo run` inside, mode bypass
 *   -> take out a patch of the work -> outputs to Mastermind (the patch, files
 *   in OUTPUTS_DIR, the agent log tail) -> the new commits as a git bundle;
 *   THIS machine pushes branch mm/<item> / opens a pull request (output.ts,
 *   when the environment asks) -> DELETE the box (on every exit path)
 *
 * The agent runs inside the box with no prompts: the box is the limit.
 * Secret values go only into the box: never into argv, logs or reports. The
 * git credential never reaches the agent (mm-210.64): it is not box env, not a
 * file and not in .git/config; the push runs outside the box.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type DispatchEnv,
	formatBytes,
	INPUTS_DIR,
	OUTPUTS_DIR,
	safeFileName,
} from "@mastermind/core";
import type { AgentSettings } from "../config.ts";
import {
	appBotIdentity,
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
	type GitIdentity,
} from "../github.ts";
import {
	type AgentResult,
	LaunchError,
	parseResult,
	RESULT_SCHEMA,
	runFailure,
} from "../launcher.ts";
import type { HostRun, PreparedBox } from "./devcontainer.ts";
import {
	BOX_LABEL,
	type Box,
	type BoxDriver,
	BoxError,
	ENGINE_RUNTIME,
	type ExecResult,
} from "./driver.ts";
import type { BoxFiles } from "./files.ts";
import { QUIET_PASEO_ENV } from "./image.ts";
import {
	APP_TOKEN_MIN_LEFT_MS,
	type AppToken,
	appToken,
	CLONE_CRED_DIR,
	cloneCredential,
	deliverOutput,
	identityEnv,
	MASTERMIND_IDENTITY,
	type OutputResult,
	redact,
	splitGitSecrets,
} from "./output.ts";
import { networkPhases, splitModelSecrets } from "./proxy.ts";
import { untar } from "./tar.ts";
import type { CodeStore, Snapshot, WorkCopy } from "./workspace.ts";

export const WORKSPACE = "/workspace";
export const SECRETS_DIR = "/run/mastermind/secrets";
const PATCH = "/tmp/mastermind-result.patch";

/** The first report of a task that ran without a box (human decision D). */
export const NO_BOX_REPORT = "ran WITHOUT a box (owner's risk)";

export type BoxTask = {
	executionId: string;
	beadId: string;
	/** The runner's id: boxes carry it so a restart can sweep them. */
	runnerId: string;
	title: string;
	prompt: string;
	env: DispatchEnv;
	agent: AgentSettings;
	labels?: Record<string, string>;
	/** Resolved secret values by name (from the runner's local store). */
	secrets: Record<string, string>;
};

export type BoxRunOptions = {
	driver: BoxDriver;
	/** Image for an environment with no image. */
	defaultImage: string;
	/** Where patches are written: <outDir>/<executionId>.patch. None: not kept. */
	outDir?: string;
	/** The agent command in the box; default `paseo run` (see {@link paseoRun}). */
	agentCommand?: (task: BoxTask) => string[];
	/**
	 * The agent step through another path than exec (mm-210.73: the Paseo SDK
	 * connection, paseo-control.ts). Same result shape as `paseo run --json`.
	 * Absent or null: `agentCommand` through exec.
	 */
	runAgent?: (
		box: Box,
		task: BoxTask,
		signal: AbortSignal,
	) => Promise<ExecResult | null>;
	/**
	 * Setup and check commands through another path than exec (mm-210.74: a
	 * Paseo terminal, paseo-control.ts). Absent or null: exec.
	 */
	runCommand?: (
		box: Box,
		cmd: string,
		o: { cwd: string; signal: AbortSignal },
	) => Promise<ExecResult | null>;
	/**
	 * The item's files through another path than the Docker copy (mm-210.75:
	 * Paseo readFile/writeFile/listDirectory, paseo-control.ts). Each says
	 * undefined/false when it cannot; then the Docker copy runs.
	 */
	boxFiles?: BoxFileHooks;
	/** Waits for the agent host in the box; default `paseo status`. null: no wait. */
	readyCommand?: string[] | null;
	/** How long the agent host may take to be ready. Default 60 s. */
	readyTimeoutMs?: number;
	/** Command that keeps the box alive; default: the image's own (Paseo daemon). */
	cmd?: string[];
	/** User for every step but the root ones; default: `paseo` when present. */
	user?: string;
	/** Extra box environment (no secret values); added to {@link BOX_ENV}. */
	boxEnv?: Record<string, string>;
	/** Progress lines for the ticket (no secret values). */
	onStep?: (line: string) => void;
	log?: (line: string) => void;
	/** For the GitHub API (output pr); default: global fetch. */
	fetch?: typeof fetch;
	/** GitHub REST API base; default https://api.github.com. */
	githubApi?: string;
	/** Tries of the delivery (push, PR) after the agent; default {@link OUTPUT_ATTEMPTS}, wait {@link outputWaitMs}. */
	outputRetry?: { attempts: number; waitMs: (attempt: number) => number };
	/** Git on this machine, for the push after the agent; default: spawn. */
	hostRun?: HostRun;
	/**
	 * Code by mount (mm-210.83, workspace.ts): the runner fetches the repo
	 * into its clean clone and mounts a work copy at /workspace; the box gets
	 * no git credential and does no clone. Absent: clone in the box.
	 */
	code?: CodeStore;
	/** Clock (epoch ms) for the GitHub App token's expiry; default Date.now. */
	now?: () => number;
	/** The item's files (inputs in, outputs out); null or absent: none. */
	files?: () => BoxFiles | null;
	/**
	 * Before any box (devcontainer.ts prepareBox): the access check and the
	 * devcontainer image. Throws the reason; null: the recipe or default image.
	 */
	prepare?: (
		task: BoxTask,
		step: (line: string) => void,
		signal: AbortSignal,
	) => Promise<PreparedBox | null>;
};

export type BoxRunResult = AgentResult & {
	/** Path of the patch on the runner machine, when there was a change. */
	patch?: string;
	/** What left the box through the git host (output pr or branch). */
	output?: OutputResult;
};

/** See {@link BoxRunOptions.boxFiles}. Errors count as "cannot". */
export type BoxFileHooks = {
	/** Regular file names in `dir`; undefined: cannot. */
	list(box: Box, dir: string): Promise<string[] | undefined>;
	/** The file at `path`; null: none; undefined: cannot. */
	take(
		box: Box,
		path: string,
	): Promise<
		{ size: number; data: ReadableStream<Uint8Array> } | null | undefined
	>;
	/** Put a small file (at most {@link FILE_HOOK_MAX}) into `dir`; false: cannot. */
	put(box: Box, dir: string, name: string, bytes: Uint8Array): Promise<boolean>;
};

/** Inputs up to this size go through {@link BoxFileHooks.put}. */
export const FILE_HOOK_MAX = 1024 * 1024;

/** Thrown when the box cannot be made or filled; the agent did not start. */
export class BoxStepError extends LaunchError {
	override name = "BoxStepError";
}

/**
 * The Paseo daemon in the box listens only inside the box, without its web UI
 * and without speech (no local speech model download), in any image.
 */
/**
 * Tries of the delivery (mm-210.87), as actions/checkout retries a failed
 * git fetch: 3 tries, a random 10-20 s between them.
 */
export const OUTPUT_ATTEMPTS = 3;
export function outputWaitMs(_attempt: number): number {
	return 10_000 + Math.floor(Math.random() * 10_000);
}

/** Wait `ms`, or less when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export const BOX_ENV: Record<string, string> = {
	...QUIET_PASEO_ENV,
	PASEO_LISTEN: "127.0.0.1:6767",
	// Commits in the box are never by a person (mm-210.87); a GitHub App
	// runner sets its bot instead.
	...identityEnv(MASTERMIND_IDENTITY),
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `paseo run` command line inside the box. No secret values in it. */
export function paseoRun(task: BoxTask): string[] {
	const a = task.agent;
	// The runner's own decision only: the server sends no agent settings (mm-210.84).
	const provider = a.provider;
	const mode = a.mode ?? "bypassPermissions";
	const labels = {
		...task.labels,
		[BOX_LABEL.execution]: task.executionId,
		"mastermind.bead": task.beadId,
	};
	return [
		"paseo",
		"run",
		"--json",
		"--output-schema",
		JSON.stringify(RESULT_SCHEMA),
		"--title",
		task.title,
		"--cwd",
		WORKSPACE,
		...(provider ? ["--provider", provider] : []),
		...(a.model ? ["--model", a.model] : []),
		"--mode",
		mode,
		...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
		task.prompt,
	];
}

function tail(r: ExecResult, n = 800): string {
	return `${r.stdout}${r.stderr}`.trim().slice(-n);
}

/** Box name: a container name from the execution id. */
export function boxName(executionId: string): string {
	return `mm-box-${executionId.replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 120);
}

/** Run one task in a new box; the box is deleted before this returns. */
export async function runInBox(
	task: BoxTask,
	opts: BoxRunOptions,
	signal: AbortSignal,
): Promise<BoxRunResult> {
	const { driver } = opts;
	const log = opts.log ?? (() => {});
	const step = (line: string) => {
		log(`${task.beadId}: box: ${line}`);
		try {
			opts.onStep?.(line);
		} catch {}
	};
	const env = task.env;
	const timeoutMin = env.limits?.timeoutMin;
	const stop = new AbortController();
	let timedOut = false;
	const timer = timeoutMin
		? setTimeout(() => {
				timedOut = true;
				stop.abort();
			}, timeoutMin * 60_000)
		: undefined;
	const all = AbortSignal.any([signal, stop.signal]);
	let box: Box | undefined;
	let image: string | undefined;
	let copy: WorkCopy | undefined;
	/** In-box owner of the mounted work copy before it went to the box user. */
	let owner: string | undefined;
	const kill = () => {
		box?.destroy().catch(() => {});
	};
	all.addEventListener("abort", kill, { once: true });
	const stopped = () =>
		new LaunchError(
			timedOut ? `box timed out after ${timeoutMin} min` : "agent stopped",
		);
	try {
		if (all.aborted) throw stopped();
		const t0 = Date.now();
		// GitHub App (mm-210.69): one token for this one repo, as GIT_TOKEN for
		// the access check, the clone, the push and the PR API. The app key
		// stays in this process.
		const now = opts.now ?? Date.now;
		const mint = async (): Promise<AppToken | null> => {
			if (!env.repo) return null;
			const f = opts.fetch ?? fetch;
			try {
				return await appToken(task.secrets, env.repo, {
					now: now(),
					fetch: ((u: string, init: RequestInit = {}) =>
						f(u, {
							...init,
							signal: AbortSignal.any([all, AbortSignal.timeout(30_000)]),
						})) as typeof fetch,
				});
			} catch (error) {
				if (all.aborted) throw stopped();
				throw new BoxStepError(
					error instanceof Error ? error.message : String(error),
				);
			}
		};
		let app = await mint();
		const taskSecrets = () => app?.secrets ?? task.secrets;
		if (app)
			step(
				`GitHub App token for ${app.repo} (contents, pull requests write) until ${new Date(app.expiresAt).toISOString().slice(11, 16)} UTC`,
			);
		// Commits as the App's bot, never as a person (mm-210.87).
		const author: GitIdentity | null = app
			? await appBotIdentity({
					appId: task.secrets[GITHUB_APP_ID] ?? "",
					pem: task.secrets[GITHUB_APP_PRIVATE_KEY] ?? "",
					...(task.secrets[GITHUB_APP_SLUG]
						? { slug: task.secrets[GITHUB_APP_SLUG] }
						: {}),
					...(app.secrets.GIT_TOKEN ? { token: app.secrets.GIT_TOKEN } : {}),
					fetch: ((u: string, init: RequestInit = {}) =>
						(opts.fetch ?? fetch)(u, {
							...init,
							signal: AbortSignal.any([all, AbortSignal.timeout(30_000)]),
						})) as typeof fetch,
				})
			: null;
		if (author) step(`commits by ${author.name} <${author.email}>`);
		let prep: PreparedBox | null = null;
		if (opts.prepare)
			try {
				prep = await opts.prepare(
					{ ...task, secrets: taskSecrets() },
					step,
					all,
				);
			} catch (error) {
				if (all.aborted) throw stopped();
				throw new BoxStepError(
					error instanceof Error ? error.message : String(error),
				);
			}
		if (all.aborted) throw stopped();
		// The git credential stays on this machine; the rest goes into the box.
		const split = splitGitSecrets({ ...taskSecrets(), ...prep?.secrets });
		let gitSecrets = split.git;
		// The model credential stays out of the box too (mm-210.70): the
		// driver's proxy box adds it; the box gets a placeholder.
		const { model, box: secrets } = splitModelSecrets(split.box);
		image = prep
			? prep.image
			: await driver.ensureImage({
					image: env.image || opts.defaultImage,
					tools: env.tools ?? [],
					...(env.recipeHash ? { hash: env.recipeHash } : {}),
				});
		if (all.aborted) throw stopped();

		// Code by mount: the clean clone and the work copy on this machine.
		if (opts.code && env.repo) {
			const t1 = Date.now();
			try {
				copy = await opts.code.checkout({
					repo: env.repo,
					ref: env.ref,
					executionId: task.executionId,
					secrets: gitSecrets,
					signal: all,
				});
			} catch (error) {
				if (all.aborted) throw stopped();
				throw new BoxStepError(
					redact(
						error instanceof Error ? error.message : String(error),
						gitSecrets,
					),
				);
			}
			step(
				`work copy of ${env.repo} at ${env.ref || "HEAD"} (${copy.base.slice(0, 12)}) on this machine in ${((Date.now() - t1) / 1000).toFixed(1)} s; mounted at ${WORKSPACE}, no git credential in the box`,
			);
		}

		// Secrets: env vars of the box (the agent host and its agents inherit them)
		// and files in SECRETS_DIR. Values never go into argv or logs.
		const secretEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(secrets))
			if (ENV_NAME.test(k)) secretEnv[k] = v;
		// Two network phases: setup gets more hosts than the agent.
		const phases = networkPhases(env.network, env.repo);
		const runtime = env.runtime ? ENGINE_RUNTIME[env.runtime] : undefined;
		box = await driver.create({
			image,
			name: boxName(task.executionId),
			labels: {
				[BOX_LABEL.runner]: task.runnerId,
				[BOX_LABEL.item]: task.beadId,
				[BOX_LABEL.execution]: task.executionId,
			},
			limits: {
				...(env.limits?.cpu ? { cpu: env.limits.cpu } : {}),
				...(env.limits?.memoryMb ? { memoryMb: env.limits.memoryMb } : {}),
			},
			network: phases ? { allow: phases.setup } : (env.network ?? "open"),
			...(runtime ? { runtime } : {}),
			env: {
				...BOX_ENV,
				...(author ? identityEnv(author) : {}),
				...prep?.env,
				...opts.boxEnv,
				...secretEnv,
			},
			...(opts.cmd ? { cmd: opts.cmd } : {}),
			...(model ? { model } : {}),
			...(copy ? { mounts: [{ source: copy.dir, target: WORKSPACE }] } : {}),
		});
		if (all.aborted) throw stopped();
		const b = box;
		let user = prep?.user ?? opts.user;
		type Where = {
			root?: boolean;
			workdir?: string;
			env?: Record<string, string>;
		};
		const run = async (cmd: string[], o: Where = {}) => {
			const as = o.root ? "root" : user;
			try {
				return await b.exec(cmd, {
					workdir: o.workdir ?? (o.root ? "/" : WORKSPACE),
					...(as ? { user: as } : {}),
					...(o.env ? { env: o.env } : {}),
					signal: all,
				});
			} catch (error) {
				if (all.aborted) throw stopped();
				throw error;
			}
		};
		const must = async (what: string, cmd: string[], o: Where = {}) => {
			const r = await run(cmd, o);
			if (all.aborted) throw stopped();
			if (r.code !== 0)
				throw new BoxStepError(
					redact(`${what} exited ${r.code}: ${tail(r)}`, gitSecrets),
				);
			return r;
		};

		// The box user: `paseo` when the image has it (the Paseo image starts as
		// root and runs its daemon as paseo), else the image's own user.
		if (user === undefined) {
			const p = await run(["id", "-u", "paseo"], { root: true });
			if (p.code === 0) user = "paseo";
		}
		// The workspace and the secret files belong to that user.
		const uid =
			(await must("id", ["id", "-u"], { workdir: "/" })).stdout.trim() || "0";
		if (copy) {
			// The mounted work copy: to the box user now, back after the agent
			// (rootless Podman and Docker map users differently; the owner as
			// the box sees it is the one to give it back to).
			const gid =
				(await must("id", ["id", "-g"], { workdir: "/" })).stdout.trim() || uid;
			const r = await must(
				"prepare (mounted work copy)",
				[
					"sh",
					"-c",
					`o="$(stat -c %u:%g ${WORKSPACE})" && mkdir -p ${SECRETS_DIR} && chown ${uid} ${SECRETS_DIR} && chmod 700 ${SECRETS_DIR} && chown -R ${uid}:${gid} ${WORKSPACE} && echo "$o"`,
				],
				{ root: true },
			);
			owner = r.stdout.trim().split("\n").pop() || "0:0";
		} else {
			// CLONE_CRED_DIR: the deploy key for the clone only (removed after it).
			const private_ = env.repo
				? `${SECRETS_DIR} ${CLONE_CRED_DIR}`
				: SECRETS_DIR;
			const dirs = `${WORKSPACE} ${private_}`;
			await must(
				"prepare",
				[
					"sh",
					"-c",
					`mkdir -p ${dirs} && chown ${uid} ${dirs} && chmod 700 ${private_}`,
				],
				{ root: true },
			);
		}
		const files = Object.entries(secrets).map(([name, data]) => ({
			name,
			data,
			mode: 0o444,
		}));
		if (files.length) await b.copyIn(SECRETS_DIR, files);
		step(`box ${b.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
		if (model)
			step(`${model.secret}: stays outside the box; the box proxy adds it`);

		// Checkout. Repo and ref go in as arguments to a fixed script. The git
		// credential is in the env of this one command (and a deploy key in
		// CLONE_CRED_DIR until it ends): nothing of it stays in the box.
		let base: string | null = null;
		if (copy) {
			base = copy.base;
			step(`checked out ${env.repo} at ${env.ref} (${base.slice(0, 12)})`);
		} else if (env.repo) {
			const cred = cloneCredential(gitSecrets);
			try {
				if (cred.key)
					await b.copyIn(CLONE_CRED_DIR, [
						{ name: "key.in", data: cred.key, mode: 0o444 },
					]);
				await must(
					`clone ${env.repo} at ${env.ref}`,
					[
						"sh",
						"-c",
						[
							"git init -q .",
							cred.script,
							'git remote add origin "$1"',
							'git fetch -q --depth 1 origin "$2"',
							"git checkout -q FETCH_HEAD",
						]
							.filter(Boolean)
							.join(" && "),
						"clone",
						env.repo,
						env.ref || "HEAD",
					],
					{ env: cred.env },
				);
			} finally {
				if (!all.aborted)
					await must(
						"remove the clone credential",
						["rm", "-rf", CLONE_CRED_DIR],
						{
							root: true,
						},
					);
			}
			base = (
				await must("git rev-parse", ["git", "rev-parse", "HEAD"])
			).stdout.trim();
			step(`checked out ${env.repo} at ${env.ref} (${base.slice(0, 12)})`);
		}
		for (const l of prep?.lifecycle ?? []) await must(l.what, l.cmd);
		if (prep?.lifecycle.length)
			step(`devcontainer lifecycle: ${prep.lifecycle.length} commands passed`);
		const shell = async (what: string, cmd: string) => {
			const r = await opts.runCommand?.(b, cmd, {
				cwd: WORKSPACE,
				signal: all,
			});
			if (!r) return must(what, ["sh", "-c", cmd]);
			if (all.aborted) throw stopped();
			if (r.code !== 0)
				throw new BoxStepError(
					redact(`${what} exited ${r.code}: ${tail(r)}`, gitSecrets),
				);
			return r;
		};
		for (const cmd of env.setup ?? []) await shell(`setup \`${cmd}\``, cmd);
		for (const cmd of env.check ?? []) await shell(`check \`${cmd}\``, cmd);
		if ((env.setup?.length ?? 0) + (env.check?.length ?? 0) > 0)
			step("setup and check passed");
		// The agent phase: only the environment's allow list from here on.
		if (phases) {
			if (!b.setAllow)
				throw new BoxStepError(
					`the box driver ${driver.name} cannot switch the network to the agent phase`,
				);
			try {
				await b.setAllow(phases.agent);
			} catch (error) {
				if (all.aborted) throw stopped();
				throw new BoxStepError(
					error instanceof Error ? error.message : String(error),
				);
			}
			if (all.aborted) throw stopped();
			step(`network: agent phase, only ${phases.agent.join(", ")}`);
		}

		// The item's files: inputs into INPUTS_DIR; the agent leaves outputs in OUTPUTS_DIR.
		const io = opts.files?.() ?? null;
		let prompt = prep?.instructions
			? `${task.prompt}\n\n${prep.instructions}`
			: task.prompt;
		if (io) {
			if (base)
				await must("git exclude", [
					"sh",
					"-c",
					"printf '.mastermind/\\n' >> .git/info/exclude",
				]);
			await must("files dirs", ["mkdir", "-p", INPUTS_DIR, OUTPUTS_DIR]);
			const names = await filesIn(b, io, task.beadId, opts.boxFiles).catch(
				(error) => {
					throw new BoxStepError(
						`files in: ${error instanceof Error ? error.message : error}`,
					);
				},
			);
			if (names.length)
				step(
					`files in: ${names.map((f) => `${f.name} (${formatBytes(f.size)})`).join(", ")} at ${INPUTS_DIR}`,
				);
			prompt += `\n\n${filesPrompt(names.map((f) => f.name))}`;
		}

		const ready =
			opts.readyCommand === undefined
				? ["paseo", "status", "--json"]
				: opts.readyCommand;
		if (ready) {
			const until = Date.now() + (opts.readyTimeoutMs ?? 60_000);
			for (;;) {
				const r = await run(ready);
				if (r.code === 0) break;
				if (Date.now() > until)
					throw new BoxStepError(
						`agent host in the box is not ready: ${tail(r)}\n${await b.logs(30).catch(() => "")}`.trim(),
					);
				await Bun.sleep(500);
				if (all.aborted) throw stopped();
			}
		}

		const cmd = (opts.agentCommand ?? paseoRun)({ ...task, prompt });
		const r =
			(await opts.runAgent?.(b, { ...task, prompt }, all)) ?? (await run(cmd));
		if (all.aborted) throw stopped();
		let snap: Snapshot | undefined;
		const sendOut = async (patch: boolean) => {
			if (!io) return;
			try {
				const sent = await filesOut(b, io, task.beadId, opts.boxFiles, {
					log: `${r.stdout}${r.stderr}`,
					patch:
						!patch || !base
							? null
							: copy
								? { text: snap?.patch ?? "" }
								: { path: PATCH },
				});
				if (sent.length) step(`files out: ${sent.join(", ")}`);
			} catch (error) {
				if (all.aborted) throw stopped();
				step(
					`files out failed: ${error instanceof Error ? error.message : error}`,
				);
			}
		};
		if (r.code !== 0) {
			await sendOut(false);
			throw new LaunchError(runFailure(r));
		}
		const result: BoxRunResult = parseResult(r.stdout);

		// Take the work out as a patch against the checked-out commit.
		if (copy && opts.code) {
			// The work copy back to its owner, then read it here as data.
			await must(
				"give the work copy back",
				["sh", "-c", `chown -R ${owner} ${WORKSPACE}`],
				{ root: true },
			);
			owner = undefined;
			try {
				snap = await opts.code.snapshot(copy, {
					exclude: ["/.mastermind/"],
					signal: all,
				});
			} catch (error) {
				if (all.aborted) throw stopped();
				throw new BoxStepError(
					`read the changes: ${error instanceof Error ? error.message : error}`,
				);
			}
			if (snap.patch && opts.outDir) {
				await mkdir(opts.outDir, { recursive: true });
				const path = join(opts.outDir, `${task.executionId}.patch`);
				await writeFile(path, snap.patch, { mode: 0o600 });
				result.patch = path;
				step(
					`changes read on this machine: ${snap.files} file${snap.files === 1 ? "" : "s"}, patch ${snap.patch.length} bytes`,
				);
			}
		} else if (base) {
			const p = await run([
				"sh",
				"-c",
				`git add -A && git diff --cached --binary "$1" > ${PATCH}`,
				"diff",
				base,
			]);
			if (p.code === 0) {
				const [file] = untar(await b.copyOut(PATCH));
				if (file && file.data.length > 0 && opts.outDir) {
					await mkdir(opts.outDir, { recursive: true });
					const path = join(opts.outDir, `${task.executionId}.patch`);
					await writeFile(path, file.data, { mode: 0o600 });
					result.patch = path;
					step(`patch taken out: ${file.data.length} bytes`);
				}
			} else log(`${task.beadId}: box: no patch: ${tail(p, 300)}`);
		}
		await sendOut(true);

		// Code leaves through the git host: branch mm/<item>, pull request.
		// A failed delivery is tried again, alone, on the same work (mm-210.87):
		// the agent does not run again for a push or PR API failure.
		const tries = opts.outputRetry?.attempts ?? OUTPUT_ATTEMPTS;
		const wait = opts.outputRetry?.waitMs ?? outputWaitMs;
		for (let attempt = 1; base && result.status === "done"; attempt++) {
			try {
				// A long task: the app token needs 10 min left for the push.
				if (app && app.expiresAt - now() < APP_TOKEN_MIN_LEFT_MS) {
					app = await mint();
					gitSecrets = splitGitSecrets({
						...taskSecrets(),
						...prep?.secrets,
					}).git;
					step("GitHub App token minted again for the push");
				}
				const out =
					copy && snap && opts.code
						? await opts.code.deliver(copy, snap, {
								signal: all,
								itemId: task.beadId,
								title: task.title,
								output: env.output,
								secrets: gitSecrets,
								...(author ? { author } : {}),
								...(opts.fetch ? { fetch: opts.fetch } : {}),
								...(opts.githubApi ? { githubApi: opts.githubApi } : {}),
							})
						: await deliverOutput({
								exec: (cmd) => run(cmd),
								takeOut: async (path) => {
									const [file] = untar(await b.copyOut(path));
									if (!file) throw new Error(`${path} is not in the box`);
									return file.data;
								},
								...(opts.hostRun ? { host: opts.hostRun } : {}),
								signal: all,
								itemId: task.beadId,
								title: task.title,
								output: env.output,
								repo: env.repo,
								ref: env.ref,
								baseSha: base,
								secrets: gitSecrets,
								...(author ? { author } : {}),
								...(opts.fetch ? { fetch: opts.fetch } : {}),
								...(opts.githubApi ? { githubApi: opts.githubApi } : {}),
							});
				if (out) {
					result.output = out;
					step(out.line);
				}
				break;
			} catch (error) {
				if (all.aborted) throw stopped();
				const why = error instanceof Error ? error.message : String(error);
				if (attempt < tries) {
					const ms = wait(attempt);
					step(
						`output failed (try ${attempt} of ${tries}): ${why}; the push alone again in ${Math.round(ms / 1000)} s`,
					);
					await abortableSleep(ms, all);
					if (all.aborted) throw stopped();
					continue;
				}
				step(`output failed: ${why}`);
				result.status = "failed";
				const kept = result.patch
					? ` The work is kept on the runner as a patch: ${result.patch}`
					: "";
				result.summary = `${result.summary}\n\noutput failed after ${tries} tries: ${why}.${kept}`;
			}
		}
		return result;
	} catch (error) {
		if (all.aborted && !(error instanceof BoxStepError)) throw stopped();
		if (error instanceof LaunchError) throw error;
		throw new BoxStepError(
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		clearTimeout(timer);
		all.removeEventListener("abort", kill);
		// A work copy not given back (a failed or stopped task): give it back
		// while the box still runs, so this machine can delete it.
		if (box && copy && owner && !all.aborted)
			await box
				.exec(["sh", "-c", `chown -R ${owner} ${WORKSPACE}`], {
					user: "root",
					workdir: "/",
				})
				.catch(() => {});
		if (box) {
			await box.destroy().catch((error) => {
				log(`${task.beadId}: box: delete ${box?.name} failed: ${error}`);
			});
			step(`box ${box.name} deleted`);
		}
		if (copy && opts.code) {
			const img = image;
			const wipe =
				driver.wipe && img
					? (dir: string) => driver.wipe?.(dir, img) ?? Promise.resolve()
					: undefined;
			await opts.code.remove(copy, wipe).then(
				() => step("work copy deleted"),
				(error) => {
					log(`${task.beadId}: box: work copy ${copy?.dir} stays: ${error}`);
					step(`work copy could not be deleted: ${error}`);
				},
			);
		}
	}
}

/** The prompt lines that tell the agent where its files are. */
export function filesPrompt(inputs: string[]): string {
	const lines = inputs.length
		? [`Input files of this task are in ${INPUTS_DIR}: ${inputs.join(", ")}.`]
		: [];
	lines.push(
		`To hand files back (reports, artifacts), put them in ${OUTPUTS_DIR} (plain files, up to ${MAX_OUT_FILES}).`,
	);
	return lines.join("\n");
}

/** Outputs taken from OUTPUTS_DIR, at most. */
export const MAX_OUT_FILES = 20;
/** The agent log goes out as its last bytes. */
const LOG_TAIL_BYTES = 256 * 1024;

/** Stream one file into the box (buffered when the driver cannot stream). */
async function putInBox(
	b: Box,
	dir: string,
	f: { name: string; size: number; data: ReadableStream<Uint8Array> },
): Promise<void> {
	if (b.copyInStream) return b.copyInStream(dir, { ...f, mode: 0o444 });
	const data = new Uint8Array(await new Response(f.data).arrayBuffer());
	await b.copyIn(dir, [{ name: f.name, data, mode: 0o444 }]);
}

/** Stream one file out of the box (buffered when the driver cannot stream). */
async function takeFromBox(
	b: Box,
	path: string,
): Promise<{ size: number; data: ReadableStream<Uint8Array> } | null> {
	if (b.copyOutStream) return b.copyOutStream(path);
	const [file] = untar(await b.copyOut(path));
	return file
		? { size: file.data.length, data: new Blob([file.data]).stream() }
		: null;
}

/** Copy the item's inputs into INPUTS_DIR; returns name and size per file. */
async function filesIn(
	b: Box,
	io: BoxFiles,
	beadId: string,
	hooks?: BoxFileHooks,
) {
	const done: { name: string; size: number }[] = [];
	for (const f of await io.stage(beadId)) {
		const got = await io.read(beadId, f.name);
		if (!got) throw new Error(`${f.name} is gone from the bucket`);
		if (hooks && got.size <= FILE_HOOK_MAX) {
			const bytes = new Uint8Array(await new Response(got.data).arrayBuffer());
			const ok = await hooks
				.put(b, INPUTS_DIR, f.name, bytes)
				.catch(() => false);
			if (!ok)
				await putInBox(b, INPUTS_DIR, {
					name: f.name,
					size: bytes.length,
					data: new Blob([bytes]).stream(),
				});
		} else await putInBox(b, INPUTS_DIR, { name: f.name, ...got });
		done.push({ name: f.name, size: got.size });
	}
	return done;
}

/**
 * Upload the outputs: the patch (changes.patch), the plain files in
 * OUTPUTS_DIR, and the agent log tail (agent.log); then tell Mastermind.
 * Returns `name (size)` per file.
 */
async function filesOut(
	b: Box,
	io: BoxFiles,
	beadId: string,
	hooks: BoxFileHooks | undefined,
	/** The patch: a file in the box, or text from this machine (code by mount). */
	o: { log: string; patch: { path: string } | { text: string } | null },
): Promise<string[]> {
	const sent: { name: string; size: number }[] = [];
	const send = async (name: string, path: string) => {
		const viaHook = await hooks?.take(b, path).catch(() => undefined);
		const f = viaHook === undefined ? await takeFromBox(b, path) : viaHook;
		if (!f || (name === "changes.patch" && f.size === 0)) {
			await f?.data.cancel();
			return;
		}
		await io.write(beadId, name, f.data, { size: f.size });
		sent.push({ name, size: f.size });
	};
	if (o.patch && "path" in o.patch) await send("changes.patch", o.patch.path);
	else if (o.patch?.text) {
		const bytes = new TextEncoder().encode(o.patch.text);
		await io.write(beadId, "changes.patch", new Blob([bytes]).stream(), {
			size: bytes.length,
		});
		sent.push({ name: "changes.patch", size: bytes.length });
	}
	const hooked = await hooks?.list(b, OUTPUTS_DIR).catch(() => undefined);
	const listed = hooked
		? { stdout: hooked.join("\n") }
		: await b.exec(
				[
					"sh",
					"-c",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell script
					'for f in "$1"/*; do [ -f "$f" ] && [ ! -L "$f" ] && printf \'%s\\n\' "${f##*/}"; done; true',
					"list",
					OUTPUTS_DIR,
				],
				{ workdir: "/" },
			);
	const names = listed.stdout
		.split("\n")
		.filter((n) => n && safeFileName(n) === n && n !== "agent.log")
		.slice(0, MAX_OUT_FILES);
	for (const n of names) await send(n, `${OUTPUTS_DIR}/${n}`);
	const log = new TextEncoder().encode(o.log);
	const tailBytes = log.subarray(Math.max(0, log.length - LOG_TAIL_BYTES));
	if (tailBytes.length) {
		await io.write(beadId, "agent.log", new Blob([tailBytes]).stream(), {
			size: tailBytes.length,
			contentType: "text/plain; charset=utf-8",
		});
		sent.push({ name: "agent.log", size: tailBytes.length });
	}
	if (sent.length)
		await io.out(
			beadId,
			sent.map((f) => f.name),
		);
	return sent.map((f) => `${f.name} (${formatBytes(f.size)})`);
}

/**
 * Delete the boxes of this runner that are not in flight (after a crash or a
 * kill, at start). Returns the names it deleted.
 */
export async function sweepBoxes(
	driver: BoxDriver,
	runnerId: string,
	inFlight: ReadonlySet<string> = new Set(),
): Promise<string[]> {
	const boxes = await driver.list({ [BOX_LABEL.runner]: runnerId });
	const gone: string[] = [];
	for (const b of boxes) {
		if (inFlight.has(b.labels[BOX_LABEL.execution] ?? "")) continue;
		await driver.remove(b.id);
		gone.push(b.name);
	}
	return gone;
}

export { BoxError };
