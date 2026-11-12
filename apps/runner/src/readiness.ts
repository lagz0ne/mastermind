/**
 * Worker readiness (mm-210.59): the runner asks for work only when its checks
 * pass, and only for the environments whose own checks pass.
 *
 *   onboarding -> checking -> ready <-> degraded
 *
 * - onboarding: `mastermind-runner onboard` has not finished here (the config
 *   has no `onboardedAt`). The runner connects and reports, but takes no work.
 * - checking: the first checks have not all run yet.
 * - ready: the runner-wide checks pass (Paseo, providers, workdir, box
 *   engine, queues). `readyEnvironments` lists the environments whose own
 *   checks pass (every needed secret present).
 * - degraded: a runner-wide check fails (engine gone, Paseo down). It is
 *   ready again when the checks pass.
 *
 * The checks run on start and every {@link RECHECK_MS}; the result goes into
 * the status (diagnostics) so that the dispatcher enforces it too.
 */
import type { FailedCheck, RunnerReadiness } from "@mastermind/core";
import { ENGINE_RUNTIME } from "./box/driver.ts";
import type { RunnerSettings } from "./config.ts";
import { type Checks, problems } from "./diagnostics.ts";
import type { Routing } from "./routing.ts";
import type { SecretsState } from "./secrets/state.ts";

/** Re-check readiness this often (and on start). */
export const RECHECK_MS = 5 * 60_000;

/** The box engine as the last check saw it. */
export type BoxCheck =
	/** `runtimes`: the installed OCI runtimes; absent: unknown. */
	| { ok: true; runtimes?: string[] }
	| { ok: false; problem: string; fix: string }
	/** --no-box: no engine needed. */
	| null;

export type ReadinessFacts = {
	/** `onboard` finished on this machine (config `onboardedAt`). */
	onboarded: boolean;
	/** Paseo, providers, workdir; `checkedAt` null: not run yet. */
	checks: Checks;
	/** undefined: not checked yet. */
	box: BoxCheck | undefined;
	/** undefined: not learned yet. */
	secrets: SecretsState | undefined;
	settings: RunnerSettings;
	routing: Pick<Routing, "environments" | "implicit">;
	/** The state before this evaluation (ready vs degraded). */
	previous?: RunnerReadiness | null;
	now?: () => Date;
};

/** Environments this runner may be offered: the bound ones, else all known. */
function candidateEnvironments(
	f: Pick<ReadinessFacts, "secrets" | "routing">,
): string[] {
	const known = f.secrets?.needs?.environments.map((e) => e.name) ?? [];
	const bound = Object.keys(f.routing.environments);
	if (f.routing.implicit || !bound.length) return known;
	return known.filter((n) => bound.includes(n));
}

/** The readiness the facts give. Pure. */
export function evaluate(f: ReadinessFacts): RunnerReadiness {
	const failed: FailedCheck[] = [];
	if (!f.onboarded)
		failed.push({
			check: "onboard",
			problem: "onboarding has not finished on this machine",
			fix: "mastermind-runner onboard",
		});
	if (f.box && !f.box.ok)
		failed.push({ check: "engine", problem: f.box.problem, fix: f.box.fix });
	if (f.checks.checkedAt)
		for (const p of problems(f.checks, f.settings))
			failed.push({
				check: p.problem.startsWith("the Paseo")
					? "paseo"
					: p.problem.startsWith("provider")
						? "provider"
						: p.problem.startsWith("workdir")
							? "workdir"
							: "queues",
				problem: p.problem,
				fix: p.fix,
			});
	else if (!f.settings.queues.length)
		failed.push({
			check: "queues",
			problem: "no queues",
			fix: "--queue <q> --save",
		});

	// Per environment: every needed secret present.
	const envs = candidateEnvironments(f);
	const notReady = new Set<string>();
	if (f.secrets && !f.secrets.needs)
		failed.push({
			check: "environments",
			problem: `the environments are unknown: ${f.secrets.problem ?? "no answer"}`,
			fix: "check the connection to Mastermind: mastermind-runner doctor",
		});
	const missing = new Map<string, string[]>();
	for (const row of f.secrets?.rows ?? [])
		if (!row.present)
			for (const env of row.neededBy)
				missing.set(env, [...(missing.get(env) ?? []), row.name]);
	for (const env of envs) {
		const names = missing.get(env);
		if (!names?.length) continue;
		notReady.add(env);
		failed.push({
			check: "secrets",
			environment: env,
			problem: `missing secrets: ${names.join(", ")}`,
			fix: names.map((n) => `mastermind-runner secrets set ${n}`).join("; "),
		});
	}

	// Per environment: the box runtime it asks for (mm-210.63).
	for (const e of f.secrets?.needs?.environments ?? []) {
		if (!e.runtime || !envs.includes(e.name)) continue;
		const why = runtimeProblem(e.runtime, f.box);
		if (!why) continue;
		notReady.add(e.name);
		failed.push({
			check: "runtime",
			environment: e.name,
			problem: why.problem,
			fix: why.fix,
		});
	}

	const runnerWide = failed.some((c) => !c.environment);
	const pending =
		!f.checks.checkedAt || f.box === undefined || f.secrets === undefined;
	const state: RunnerReadiness["state"] = !f.onboarded
		? "onboarding"
		: runnerWide && !(pending && !f.previous)
			? "degraded"
			: pending
				? "checking"
				: "ready";
	return {
		state,
		readyEnvironments:
			state === "ready" ? envs.filter((e) => !notReady.has(e)) : [],
		failedChecks: failed,
		checkedAt: f.checks.checkedAt ?? null,
	};
}

/** Why the engine cannot start boxes with `runtime`; null: it can (or the engine check fails anyway). */
export function runtimeProblem(
	runtime: string,
	box: BoxCheck | undefined,
): { problem: string; fix: string } | null {
	const engine = (ENGINE_RUNTIME as Record<string, string>)[runtime];
	if (!engine)
		return {
			problem: `runtime ${runtime} is not known to this runner`,
			fix: "install a newer mastermind-runner",
		};
	if (box === null)
		return {
			problem: `runtime ${runtime} needs a box; this runner runs with --no-box`,
			fix: "start the runner without --no-box",
		};
	if (!box?.ok) return null;
	if (!box.runtimes)
		return {
			problem: `runtime ${runtime}: cannot read the runtimes of the box engine`,
			fix: "mastermind-runner doctor",
		};
	if (box.runtimes.includes(engine)) return null;
	return {
		problem: `runtime ${runtime}: the box engine has no ${engine} runtime (has: ${box.runtimes.join(", ") || "none"})`,
		fix: `install gVisor and register ${engine} with the engine (gvisor.dev/docs/user_guide/install; Docker: sudo runsc install && sudo systemctl restart docker; Podman: install runsc in /usr/bin or /usr/local/bin, the paths of containers.conf [engine.runtimes])`,
	};
}

/** One line for the log: the state and why. */
export function readinessLine(r: RunnerReadiness): string {
	const why = r.failedChecks.map(
		(c) =>
			`${c.environment ? `${c.environment}: ` : ""}${c.problem}${c.fix ? ` (fix: ${c.fix})` : ""}`,
	);
	const envs =
		r.state === "ready"
			? `; environments ready: ${r.readyEnvironments.join(", ") || "none"}`
			: "";
	return `readiness: ${r.state}${envs}${why.length ? `; not ready: ${why.join("; ")}` : ""}`;
}

/** Same state, environments and failed checks (ignores checkedAt). */
export function sameReadiness(
	a: RunnerReadiness | null,
	b: RunnerReadiness,
): boolean {
	if (!a) return false;
	return (
		a.state === b.state &&
		a.readyEnvironments.join("\n") === b.readyEnvironments.join("\n") &&
		JSON.stringify(a.failedChecks) === JSON.stringify(b.failedChecks)
	);
}

/** Why this runner may not take a dispatch or offer for `env` now; null: it may. */
export function gateReason(
	r: RunnerReadiness | null | undefined,
	env: string | undefined,
): string | null {
	if (!r) return null;
	if (r.state !== "ready") {
		const own = r.failedChecks.filter((c) => !c.environment);
		return `not ready (${r.state}${own.length ? `: ${own.map((c) => c.problem).join("; ")}` : ""})`;
	}
	if (!env || r.readyEnvironments.includes(env)) return null;
	const why = r.failedChecks.filter((c) => c.environment === env);
	return `environment ${env} is not ready here${why.length ? `: ${why.map((c) => c.problem).join("; ")}` : ""}`;
}
