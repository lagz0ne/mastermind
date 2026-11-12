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
 *   checks pass (every needed secret present, the box runtime it asks for,
 *   its repo readable at its ref with its git credential, and no agent login
 *   refused with the model credential it needs: mm-210.81).
 * - degraded: a runner-wide check fails (engine gone, Paseo down). It is
 *   ready again when the checks pass.
 *
 * The checks run on start and every {@link RECHECK_MS}; the result goes into
 * the status (diagnostics) so that the dispatcher enforces it too.
 */
import type { FailedCheck, RunnerReadiness } from "@mastermind/core";
import { type AccessMap, candidateEnvironments } from "./access.ts";
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
	/** Git access per environment (access.ts); undefined: not checked yet. */
	access?: AccessMap;
	/**
	 * Set while --auto-update drains the runner before it updates and
	 * restarts (update.ts): no new work (mm-210.77).
	 */
	updating?: string | null;
	/**
	 * The agent's provider refused the model credential (a task or the
	 * doctor's box probe ended with a login failure, mm-210.81). The
	 * environments that need that secret are not ready until it changes.
	 */
	loginRefused?: LoginRefused | null;
	/** The state before this evaluation (ready vs degraded). */
	previous?: RunnerReadiness | null;
	now?: () => Date;
};

/** The readiness the facts give. Pure. */
/**
 * A model credential the agent's provider refused. `hash`: sha256 of the
 * value then (never the value): a new value lifts the refusal.
 */
export type LoginRefused = {
	secret: string;
	hash: string;
	at: string;
	/** The provider's answer, for example "Failed to authenticate". */
	problem: string;
};

/** The fix line of a refused model credential. */
export function loginFix(secret: string): string {
	return secret === "CLAUDE_CODE_OAUTH_TOKEN"
		? "run claude setup-token again, then mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN"
		: `mastermind-runner secrets set ${secret} (a value the provider accepts)`;
}

/** sha256 hex of a secret value: compare values without keeping them. */
export function secretHash(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * The refusal after a failed agent, or null: `login` is the provider's login
 * answer (launcher.ts providerLoginMessage), `env` the secrets the agent got;
 * the model credential is the first of `modelSecrets` among them.
 */
export function loginRefusal(
	login: string | null,
	env: Record<string, string>,
	modelSecrets: readonly string[],
	now: Date = new Date(),
): LoginRefused | null {
	if (!login) return null;
	const secret = modelSecrets.find((n) => env[n]);
	if (!secret) return null;
	return {
		secret,
		hash: secretHash(env[secret] as string),
		at: now.toISOString(),
		problem: login,
	};
}

/** Does the refusal still hold? Not when the value changed (or is gone). */
export function refusalHolds(
	r: LoginRefused,
	current: string | null | undefined,
): boolean {
	return !!current && secretHash(current) === r.hash;
}

export function evaluate(f: ReadinessFacts): RunnerReadiness {
	const failed: FailedCheck[] = [];
	if (!f.onboarded)
		failed.push({
			check: "onboard",
			problem: "onboarding has not finished on this machine",
			fix: "mastermind-runner onboard",
		});
	if (f.updating)
		failed.push({
			check: "update",
			problem: f.updating,
			fix: "none needed: the runner restarts by itself when no task runs",
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
	const envs = candidateEnvironments(f.secrets?.needs, f.routing);
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

	// Per environment: the provider refused the model credential it needs (mm-210.81).
	const refused = f.loginRefused;
	if (refused)
		for (const e of f.secrets?.needs?.environments ?? []) {
			if (!envs.includes(e.name) || !e.secrets.includes(refused.secret))
				continue;
			notReady.add(e.name);
			failed.push({
				check: "login",
				environment: e.name,
				problem: `the agent's provider refused ${refused.secret} (${refused.problem}, ${refused.at})`,
				fix: loginFix(refused.secret),
			});
		}

	// Per environment: its repo is readable at its ref (mm-lnm).
	for (const env of envs) {
		const a = f.access?.[env];
		if (!a || a.ok) continue;
		notReady.add(env);
		failed.push({
			check: "git",
			environment: env,
			problem: a.problem,
			fix: a.fix,
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
