/**
 * Git access per environment for readiness (mm-lnm): can this runner read the
 * environment's repo at its ref with the environment's git credential? The
 * same check runs before each task (box/devcontainer.ts prepareBox); here it
 * runs at onboarding and with every readiness re-check, so an environment
 * whose repo is not readable is not ready, with the reason, before work
 * arrives (mm-210.59 rule).
 *
 * `git ls-remote` on the runner machine; no clone. Secret values stay in
 * this process; the reasons are redacted by checkAccess.
 */
import { type AccessResult, checkAccess } from "./box/devcontainer.ts";
import { appToken, GIT_CREDENTIAL_SECRETS } from "./box/output.ts";
import { fail, pass, type StepResult } from "./onboard.ts";
import type { Routing } from "./routing.ts";
import type { Needs } from "./secrets/needs.ts";
import { resolveSecrets } from "./secrets/needs.ts";

/** One environment's git access as the last check saw it. */
export type EnvAccess =
	| { ok: true; repo: string; ref: string }
	| { ok: false; repo: string; ref: string; problem: string; fix: string };

/** Environment name -> its access; an environment without a repo or with missing secrets is absent. */
export type AccessMap = Record<string, EnvAccess>;

/** Give up on one `git ls-remote` after this long. */
export const ACCESS_TIMEOUT_MS = 30_000;

export type AccessInput = {
	needs: Needs | null;
	routing: Pick<Routing, "environments" | "implicit">;
	/** Stored secret values (SecretSource.load()). */
	store: Record<string, string>;
	/** The runner's process environment. */
	env: Record<string, string | undefined>;
	/** Default: checkAccess (tests: a fake). */
	check?: (
		repo: string,
		ref: string,
		secrets: Record<string, string>,
		signal: AbortSignal,
	) => Promise<AccessResult>;
	/**
	 * Turn the environment's secrets into the ones git uses. Default: with
	 * GitHub App secrets and a github.com repo, an installation token as
	 * GIT_TOKEN (appToken, mm-210.69), as before each task. May throw: the
	 * message is the reason.
	 */
	mint?: (
		secrets: Record<string, string>,
		repo: string,
	) => Promise<Record<string, string>>;
	timeoutMs?: number;
};

/** The secrets with a GitHub App installation token, when the app secrets are there. */
async function mintAppToken(
	secrets: Record<string, string>,
	repo: string,
): Promise<Record<string, string>> {
	return (await appToken(secrets, repo))?.secrets ?? secrets;
}

/** Environments this runner may be offered: the bound ones, else all known. */
export function candidateEnvironments(
	needs: Needs | null | undefined,
	routing: Pick<Routing, "environments" | "implicit">,
): string[] {
	const known = needs?.environments.map((e) => e.name) ?? [];
	const bound = Object.keys(routing.environments);
	if (routing.implicit || !bound.length) return known;
	return known.filter((n) => bound.includes(n));
}

/** The one line that fixes a failed access check. */
export function accessFix(
	r: Extract<AccessResult, { ok: false }>,
	repo: string,
	ref: string,
): string {
	switch (r.kind) {
		case "no-access":
			return `give the environment's git credential read access to ${repo} (mastermind-runner secrets set GIT_TOKEN, or install the GitHub App on the repo), or fix the environment's repo`;
		case "ref-missing":
			return `push ${ref} to ${repo}, or change the environment's ref`;
		case "network":
			return `check that this machine reaches ${repo}`;
		default:
			return "mastermind-runner doctor";
	}
}

/**
 * Check git access of every environment this runner may be offered that has
 * a repo and all its secrets (missing secrets are the secrets check's
 * problem). The checks run in parallel.
 */
export async function checkEnvironmentsAccess(
	i: AccessInput,
): Promise<AccessMap> {
	const names = new Set(candidateEnvironments(i.needs, i.routing));
	const check =
		i.check ??
		((repo, ref, secrets, signal) =>
			checkAccess(repo, ref, secrets, undefined, signal));
	const out: AccessMap = {};
	await Promise.all(
		(i.needs?.environments ?? [])
			.filter((e) => names.has(e.name) && e.repo)
			.map(async (e) => {
				const repo = e.repo as string;
				const ref = e.ref ?? "";
				// The runner's own git credential too (mm-210.87), as for a task.
				const { values, missing } = await resolveSecrets(
					e.secrets,
					{
						store: i.store,
						env: i.env,
						binding: i.routing.environments[e.name]?.env,
					},
					GIT_CREDENTIAL_SECRETS,
				);
				if (missing.length) return;
				let r: AccessResult;
				const ms = i.timeoutMs ?? ACCESS_TIMEOUT_MS;
				const signal = AbortSignal.timeout(ms);
				try {
					const secrets = await (i.mint ?? mintAppToken)(values, repo);
					r = await check(repo, ref, secrets, signal);
					if (!r.ok && signal.aborted)
						r = {
							ok: false,
							kind: "network",
							reason: `repo ${repo} did not answer within ${ms / 1000} s`,
						};
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					r = {
						ok: false,
						kind: "error",
						reason: `git access to ${repo}: ${message}`,
					};
				}
				out[e.name] = r.ok
					? { ok: true, repo, ref }
					: {
							ok: false,
							repo,
							ref,
							problem: r.reason,
							fix: accessFix(r, repo, ref),
						};
			}),
	);
	return out;
}

/** The onboard step: FAIL with every unreadable environment, else the readable ones. */
export function accessStep(a: AccessMap): StepResult {
	const rows = Object.entries(a);
	const bad = rows.flatMap(([n, x]) => (x.ok ? [] : [{ n, ...x }]));
	if (bad.length)
		return fail(
			bad.map((b) => `${b.n}: ${b.problem}`).join("; "),
			bad.map((b) => `${b.n}: ${b.fix}`).join("; "),
		);
	return pass(
		rows.length
			? rows.map(([n, x]) => `${n}: ${x.repo} readable`).join(", ")
			: "no environment has a repo",
	);
}
