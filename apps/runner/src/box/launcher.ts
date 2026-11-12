/**
 * The runner's box mode: every dispatch runs in a throwaway box (run.ts).
 *
 *   boxCheck     before the start: only the secrets (values from this machine;
 *                missing: decline with the names). Requirements, checkout,
 *                setup and check happen in the box, not on this machine.
 *   BoxLauncher  the AgentLauncher that runs the agent in the box; before the
 *                box, on this machine: the git access check and the
 *                devcontainer image (devcontainer.ts).
 */
import { dirname, join } from "node:path";
import { type Dispatch, workOutputOf } from "@mastermind/core";
import type { CheckResult } from "../check.ts";
import { configPath, type RunnerSettings } from "../config.ts";
import {
	type AgentLauncher,
	type AgentResult,
	type AgentSpec,
	LaunchError,
} from "../launcher.ts";
import type { Decision } from "../routing.ts";
import { missingReason, resolveSecrets } from "../secrets/needs.ts";
import { SecretStore, secretsPath } from "../secrets/store.ts";
import { prepareBox } from "./devcontainer.ts";
import { DockerDriver, dockerEndpoint } from "./docker.ts";
import type { Box, BoxDriver } from "./driver.ts";
import type { BoxFiles } from "./files.ts";
import { DEFAULT_BOX_IMAGE } from "./image.ts";
import {
	listFilesOverPaseo,
	readFileOverPaseo,
	runAgentOverPaseo,
	runCommandOverPaseo,
	writeFileOverPaseo,
} from "./paseo-control.ts";
import {
	dockerExecStream,
	linkDriver,
	type PaseoLinkOptions,
	paseoLinkOf,
	sweepPaseoLinks,
} from "./paseo-link.ts";
import {
	type BoxFileHooks,
	type BoxRunOptions,
	runInBox,
	sweepBoxes,
	WORKSPACE,
} from "./run.ts";
import { CodeStore, codeMode } from "./workspace.ts";

export type BoxCheckDeps = {
	/** Stored secret values; default: the runner's secret store. */
	loadSecrets?: () => Promise<Record<string, string>>;
	env?: Record<string, string | undefined>;
};

/** The runner's `check` in box mode: resolve the secrets, nothing else. */
export function boxCheck(deps: BoxCheckDeps = {}) {
	return async (
		d: Pick<Dispatch, "env">,
		_s: RunnerSettings,
		decision: Pick<Extract<Decision, { ok: true }>, "binding">,
	): Promise<CheckResult> => {
		let store: Record<string, string>;
		try {
			store = await (
				deps.loadSecrets ?? (() => new SecretStore(secretsPath()).load())
			)();
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		const { values, missing } = await resolveSecrets(d.env.secrets ?? [], {
			store,
			env: deps.env ?? process.env,
			binding: decision.binding?.env,
		});
		if (missing.length) return { ok: false, reason: missingReason(missing) };
		return { ok: true, cwd: WORKSPACE, env: values };
	};
}

export type BoxLauncherOptions = Omit<BoxRunOptions, "onStep"> & {
	runnerId: string;
	/** Progress lines per bead (box made, checkout, setup, deleted). */
	onStep?: (beadId: string, line: string) => void;
};

/** Runs each agent in a new box; `spec.env` holds the resolved secrets. */
export class BoxLauncher implements AgentLauncher {
	constructor(readonly opts: BoxLauncherOptions) {}

	async run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult> {
		if (!spec.recipe)
			throw new LaunchError("box mode: the dispatch has no environment");
		const { runnerId, onStep, ...run } = this.opts;
		const res = await runInBox(
			{
				executionId: spec.executionId,
				beadId: spec.beadId,
				runnerId,
				title: spec.title,
				prompt: spec.prompt,
				env: spec.recipe,
				agent: spec.agent,
				...(spec.labels ? { labels: spec.labels } : {}),
				secrets: spec.env ?? {},
			},
			{
				...run,
				...(onStep ? { onStep: (l: string) => onStep(spec.beadId, l) } : {}),
			},
			signal,
		);
		let summary = res.summary;
		if (res.output) summary += `\n\n${res.output.line}`;
		if (res.patch)
			summary += `\n\n(patch of the work on the runner: ${res.patch})`;
		const output = workOutputOf(res.output);
		return { status: res.status, summary, ...(output ? { output } : {}) };
	}
}

/** Image when neither the environment nor the runner names one (image.ts). */
export { DEFAULT_BOX_IMAGE };

export type BoxModeInput = {
	runnerId: string;
	env: Record<string, string | undefined>;
	/** --box-image; else MASTERMIND_BOX_IMAGE; else {@link DEFAULT_BOX_IMAGE}. */
	image?: string;
	/** Where patches are kept. */
	outDir: string;
	log: (line: string) => void;
	onStep?: (beadId: string, line: string) => void;
	driver?: BoxDriver;
	/** The item's files (inputs in, outputs out); null while not connected. */
	files?: () => BoxFiles | null;
	/**
	 * Each box as a connected host of this machine's Paseo (mm-210.68).
	 * Default: on with the Docker driver (its exec stream is the transport),
	 * off with any other driver unless given. false (--no-paseo-link, or
	 * MASTERMIND_PASEO_LINK=0): off.
	 */
	paseoLink?: false | Partial<Omit<PaseoLinkOptions, "runnerId">>;
	/**
	 * How the runner drives the agent in a box: `exec` (`docker exec paseo
	 * run`) or `paseo` (one SDK connection over the relay, mm-210.73).
	 * Default: MASTERMIND_BOX_CONTROL, else `paseo`.
	 */
	boxControl?: "exec" | "paseo";
};

/** Where the relay sockets live: next to the runner config, 0700. */
export function paseoLinkDir(env: Record<string, string | undefined>): string {
	return join(dirname(configPath(env)), "paseo-link");
}

/**
 * The driver with Paseo links (mm-210.68, mm-210.73): the relay to each box
 * daemon, the user's host when `register` (this machine's Paseo answers;
 * the sweep removes hosts an earlier run of this runner left), and the
 * SDK control connection when `control`.
 */
async function withPaseoLink(
	driver: BoxDriver,
	i: BoxModeInput,
	own: boolean,
): Promise<{ driver: BoxDriver; control: boolean }> {
	const want = i.paseoLink === false ? {} : (i.paseoLink ?? (own ? {} : null));
	const open =
		want?.open ?? (own ? dockerExecStream(dockerEndpoint(i.env)) : null);
	const control =
		(i.boxControl ?? i.env.MASTERMIND_BOX_CONTROL?.trim()) !== "exec";
	let register = i.paseoLink !== false && i.env.MASTERMIND_PASEO_LINK !== "0";
	if (!want || !open || (!register && !control))
		return { driver, control: false };
	const dir = want.dir ?? paseoLinkDir(i.env);
	if (register) {
		const gone = await sweepPaseoLinks({
			dir,
			runnerId: i.runnerId,
			...(want.paseo ? { paseo: want.paseo } : {}),
			log: (l) => {
				register = false;
				i.log(l);
			},
		});
		if (gone.length)
			i.log(
				`paseo link: removed ${gone.length} host(s) left from an earlier run`,
			);
		if (register)
			i.log(
				"paseo link: each box shows as a host 'mastermind:<item>' in this machine's Paseo (--no-paseo-link: off)",
			);
	}
	if (control)
		i.log(
			"box control: the agent runs through one Paseo connection to the box daemon (MASTERMIND_BOX_CONTROL=exec: through docker exec)",
		);
	if (!register && !control) return { driver, control: false };
	return {
		driver: linkDriver(driver, {
			...want,
			dir,
			open,
			register,
			runnerId: i.runnerId,
			log: i.log,
			...(i.onStep ? { step: i.onStep } : {}),
		}),
		control,
	};
}

/**
 * Setup/check commands in a Paseo terminal over the box's connection
 * (mm-210.74). No connection: exec (null); the agent step says why.
 */
export function paseoRunCommand(): NonNullable<BoxRunOptions["runCommand"]> {
	return async (box, cmd, o) => {
		const link = paseoLinkOf(box);
		if (!link) return null;
		const c = await link.client().catch(() => null);
		if (!c) return null;
		return runCommandOverPaseo(c, cmd, o);
	};
}

/**
 * The item's files over the box's Paseo connection (mm-210.75): listing and
 * outputs with listDirectory/readFile, inputs up to 1 MiB with writeFile.
 * No connection, or a file Paseo cannot take: the Docker copy.
 */
export function paseoBoxFiles(): BoxFileHooks {
	const client = async (box: Box) =>
		(await paseoLinkOf(box)
			?.client()
			.catch(() => null)) ?? null;
	return {
		list: async (box, dir) => {
			const c = await client(box);
			return c ? listFilesOverPaseo(c, dir) : undefined;
		},
		take: async (box, path) => {
			const c = await client(box);
			return c ? readFileOverPaseo(c, path) : undefined;
		},
		put: async (box, dir, name, bytes) => {
			const c = await client(box);
			return c ? writeFileOverPaseo(c, dir, name, bytes) : false;
		},
	};
}

/**
 * The agent step over the box's Paseo connection. No connection: the ticket
 * says so and the agent runs through exec (null).
 */
export function paseoRunAgent(
	step: (beadId: string, line: string) => void = () => {},
): NonNullable<BoxRunOptions["runAgent"]> {
	return async (box, task, signal) => {
		const link = paseoLinkOf(box);
		if (!link) return null;
		let c: Awaited<ReturnType<typeof link.client>>;
		try {
			c = await link.client();
		} catch (error) {
			step(
				task.beadId,
				`box control: ${error instanceof Error ? error.message : error}; the agent runs through exec`,
			);
			return null;
		}
		return runAgentOverPaseo(c, task, signal, {
			onAgent: (id) =>
				step(task.beadId, `agent ${id} started through the Paseo connection`),
		});
	};
}

/**
 * Box mode at runner start: the engine must answer (else a BoxError with the
 * fix), and boxes an earlier run of this runner left behind are deleted.
 */
export async function startBoxMode(i: BoxModeInput) {
	const engine0 = i.driver ?? new DockerDriver({ env: i.env, log: i.log });
	const engine = await engine0.ping();
	const { driver, control } = await withPaseoLink(engine0, i, !i.driver);
	const gone = await sweepBoxes(driver, i.runnerId);
	if (gone.length)
		i.log(
			`box: deleted ${gone.length} left from an earlier run: ${gone.join(", ")}`,
		);
	const defaultImage =
		i.image || i.env.MASTERMIND_BOX_IMAGE || DEFAULT_BOX_IMAGE;
	i.log(`box mode: ${driver.name} (${engine}), default image ${defaultImage}`);
	// Code by mount (mm-210.83): clean clones and work copies next to results.
	const how = codeMode(i.env);
	const code =
		how.mode === "mount"
			? new CodeStore(join(dirname(i.outDir), "code"), { log: i.log })
			: undefined;
	if (code) {
		const wipe = driver.wipe
			? (dir: string) => driver.wipe?.(dir, defaultImage) ?? Promise.resolve()
			: undefined;
		const left = await code.sweep(wipe);
		if (left.length)
			i.log(`box: deleted ${left.length} work copies left from an earlier run`);
	}
	i.log(
		`box code: ${how.mode === "mount" ? `the runner clones and pushes; a work copy is mounted at ${WORKSPACE} (${code?.root})` : "cloned in the box"}: ${how.why}`,
	);
	const dockerPath = boxDockerPath(i.env, engine);
	const loadStore = () => new SecretStore(secretsPath()).load();
	return {
		driver,
		check: boxCheck({ env: i.env }),
		launcher: new BoxLauncher({
			driver,
			runnerId: i.runnerId,
			defaultImage,
			outDir: i.outDir,
			log: i.log,
			...(code ? { code } : {}),
			...(i.onStep ? { onStep: i.onStep } : {}),
			...(i.files ? { files: i.files } : {}),
			...(control
				? {
						runAgent: paseoRunAgent(i.onStep),
						runCommand: paseoRunCommand(),
						boxFiles: paseoBoxFiles(),
					}
				: {}),
			prepare: (task, step, signal) =>
				prepareBox(
					task,
					{
						defaultImage,
						dockerPath,
						env: i.env,
						lookupSecrets: async (names) =>
							resolveSecrets(names, {
								store: await loadStore().catch(() => ({})),
								env: i.env,
							}),
					},
					step,
					signal,
				),
		}),
	};
}

/**
 * The docker CLI the devcontainer CLI uses: MM_BOX_DOCKER_PATH, else
 * `podman` when the engine is Podman, else `docker`. It must reach the same
 * engine (images) as the box driver.
 */
export function boxDockerPath(
	env: Record<string, string | undefined>,
	engine: string,
): string {
	const own = env.MM_BOX_DOCKER_PATH?.trim();
	if (own) return own;
	return /podman/i.test(engine) ? "podman" : "docker";
}
