/**
 * The runner's box mode: every dispatch runs in a throwaway box (run.ts).
 *
 *   boxCheck     before the start: only the secrets (values from this machine;
 *                missing: decline with the names). Requirements, checkout,
 *                setup and check happen in the box, not on this machine.
 *   BoxLauncher  the AgentLauncher that runs the agent in the box.
 */
import type { Dispatch } from "@mastermind/core";
import type { CheckResult } from "../check.ts";
import type { RunnerSettings } from "../config.ts";
import {
	type AgentLauncher,
	type AgentResult,
	type AgentSpec,
	LaunchError,
} from "../launcher.ts";
import type { Decision } from "../routing.ts";
import { missingReason, resolveSecrets } from "../secrets/needs.ts";
import { SecretStore, secretsPath } from "../secrets/store.ts";
import { DockerDriver } from "./docker.ts";
import type { BoxDriver } from "./driver.ts";
import { DEFAULT_BOX_IMAGE } from "./image.ts";
import { type BoxRunOptions, runInBox, sweepBoxes, WORKSPACE } from "./run.ts";

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
		return { status: res.status, summary };
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
};

/**
 * Box mode at runner start: the engine must answer (else a BoxError with the
 * fix), and boxes an earlier run of this runner left behind are deleted.
 */
export async function startBoxMode(i: BoxModeInput) {
	const driver = i.driver ?? new DockerDriver({ env: i.env, log: i.log });
	const engine = await driver.ping();
	const gone = await sweepBoxes(driver, i.runnerId);
	if (gone.length)
		i.log(
			`box: deleted ${gone.length} left from an earlier run: ${gone.join(", ")}`,
		);
	const defaultImage =
		i.image || i.env.MASTERMIND_BOX_IMAGE || DEFAULT_BOX_IMAGE;
	i.log(`box mode: ${driver.name} (${engine}), default image ${defaultImage}`);
	return {
		driver,
		check: boxCheck({ env: i.env }),
		launcher: new BoxLauncher({
			driver,
			runnerId: i.runnerId,
			defaultImage,
			outDir: i.outDir,
			log: i.log,
			...(i.onStep ? { onStep: i.onStep } : {}),
		}),
	};
}
