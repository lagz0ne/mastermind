/**
 * One task in one throwaway box (docs/design/box.html):
 *
 *   ensure image (cached by recipe hash) -> create box (limits, network, labels)
 *   -> clone repo at ref into /workspace -> secrets as env and files
 *   -> setup, then check (fail: the reason and the output tail)
 *   -> wait for the Paseo daemon in the box -> `paseo run` inside, mode bypass
 *   -> take out a patch of the work -> DELETE the box (on every exit path)
 *
 * The agent runs inside the box with no prompts: the box is the limit.
 * Secret values go only into the box: never into argv, logs or reports.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchEnv } from "@mastermind/core";
import type { AgentSettings } from "../config.ts";
import {
	type AgentResult,
	LaunchError,
	parseResult,
	RESULT_SCHEMA,
	runFailure,
} from "../launcher.ts";
import {
	BOX_LABEL,
	type Box,
	type BoxDriver,
	BoxError,
	type ExecResult,
} from "./driver.ts";
import { untar } from "./tar.ts";

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
};

export type BoxRunResult = AgentResult & {
	/** Path of the patch on the runner machine, when there was a change. */
	patch?: string;
};

/** Thrown when the box cannot be made or filled; the agent did not start. */
export class BoxStepError extends LaunchError {
	override name = "BoxStepError";
}

/** The Paseo daemon in the box listens only inside the box, without its web UI. */
export const BOX_ENV: Record<string, string> = {
	PASEO_LISTEN: "127.0.0.1:6767",
	PASEO_WEB_UI_ENABLED: "false",
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `paseo run` command line inside the box. No secret values in it. */
export function paseoRun(task: BoxTask): string[] {
	const a = task.agent;
	const provider = a.provider ?? task.env.agent?.provider ?? task.env.provider;
	const mode = a.mode ?? task.env.agent?.mode ?? "bypassPermissions";
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
		const image = await driver.ensureImage({
			image: env.image || opts.defaultImage,
			tools: env.tools ?? [],
			...(env.recipeHash ? { hash: env.recipeHash } : {}),
		});
		if (all.aborted) throw stopped();

		// Secrets: env vars of the box (the agent host and its agents inherit them)
		// and files in SECRETS_DIR. Values never go into argv or logs.
		const secretEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(task.secrets))
			if (ENV_NAME.test(k)) secretEnv[k] = v;
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
			network: env.network ?? "open",
			env: { ...BOX_ENV, ...opts.boxEnv, ...secretEnv },
			...(opts.cmd ? { cmd: opts.cmd } : {}),
		});
		if (all.aborted) throw stopped();
		const b = box;
		let user = opts.user;
		type Where = { root?: boolean; workdir?: string };
		const run = async (cmd: string[], o: Where = {}) => {
			const as = o.root ? "root" : user;
			try {
				return await b.exec(cmd, {
					workdir: o.workdir ?? (o.root ? "/" : WORKSPACE),
					...(as ? { user: as } : {}),
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
				throw new BoxStepError(`${what} exited ${r.code}: ${tail(r)}`);
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
		await must(
			"prepare",
			[
				"sh",
				"-c",
				`mkdir -p ${WORKSPACE} ${SECRETS_DIR} && chown ${uid} ${WORKSPACE} ${SECRETS_DIR} && chmod 700 ${SECRETS_DIR}`,
			],
			{ root: true },
		);
		const files = Object.entries(task.secrets).map(([name, data]) => ({
			name,
			data,
			mode: 0o444,
		}));
		if (files.length) await b.copyIn(SECRETS_DIR, files);
		step(`box ${b.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

		// Checkout. Repo and ref go in as arguments to a fixed script.
		let base: string | null = null;
		if (env.repo) {
			await must(`clone ${env.repo} at ${env.ref}`, [
				"sh",
				"-c",
				'git init -q . && git remote add origin "$1" && git fetch -q --depth 1 origin "$2" && git checkout -q FETCH_HEAD',
				"clone",
				env.repo,
				env.ref || "HEAD",
			]);
			base = (
				await must("git rev-parse", ["git", "rev-parse", "HEAD"])
			).stdout.trim();
			step(`checked out ${env.repo} at ${env.ref} (${base.slice(0, 12)})`);
		}
		for (const cmd of env.setup ?? [])
			await must(`setup \`${cmd}\``, ["sh", "-c", cmd]);
		for (const cmd of env.check ?? [])
			await must(`check \`${cmd}\``, ["sh", "-c", cmd]);
		if ((env.setup?.length ?? 0) + (env.check?.length ?? 0) > 0)
			step("setup and check passed");

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

		const cmd = (opts.agentCommand ?? paseoRun)(task);
		const r = await run(cmd);
		if (all.aborted) throw stopped();
		if (r.code !== 0) throw new LaunchError(runFailure(r));
		const result: BoxRunResult = parseResult(r.stdout);

		// Take the work out as a patch against the checked-out commit.
		if (base) {
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
		if (box) {
			await box.destroy().catch((error) => {
				log(`${task.beadId}: box: delete ${box?.name} failed: ${error}`);
			});
			step(`box ${box.name} deleted`);
		}
	}
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
