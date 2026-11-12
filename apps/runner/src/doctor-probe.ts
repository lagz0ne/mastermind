/**
 * `doctor --deep` step e in box mode (mm-210.82): the probe agent runs the
 * way a task runs. A throwaway box from the default image, the box's Paseo
 * daemon, and the model credential through the proxy model route (the box
 * holds only the placeholder, mm-210.70). The probe sends one real prompt
 * through Paseo, so a wrong token fails here with the provider's own error
 * (mm-210.72 maps "API Error: 401 OAuth access token is invalid" to a login
 * failure).
 *
 * Why a real prompt: Paseo's provider check (`paseo provider diagnostic`,
 * Auth.loggedIn) comes from `claude auth status`. That command says
 * loggedIn:true for a WRONG CLAUDE_CODE_OAUTH_TOKEN (checked with Claude
 * Code 2.1.322), so only a prompt proves that the credential works.
 * Mastermind never calls Anthropic itself (human, 2026-11-12).
 */
import type { DispatchEnv } from "@mastermind/core";
import { MODEL_SECRETS } from "./box/proxy.ts";
import type { AgentLauncher, AgentResult, AgentSpec } from "./launcher.ts";
import { type Lookup, lookupSecret } from "./secrets/needs.ts";

export type ModelSecretName = (typeof MODEL_SECRETS)[number];

/** The fix of a probe the provider refused, in box mode. */
export const BOX_LOGIN_FIX =
	"run claude setup-token again, then mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN (an API key: mastermind-runner secrets set ANTHROPIC_API_KEY)";

/**
 * The probe's environment: the default image, no repo, open network, no
 * output; only the model secret (the proxy keeps its value out of the box).
 */
export function probeEnv(secret?: ModelSecretName): DispatchEnv {
	return {
		name: "doctor-probe",
		repo: "",
		ref: "",
		requires: [],
		network: "open",
		output: { kind: "none" },
		secrets: secret ? [secret] : [],
	};
}

/**
 * The model credential a box would get: the first of {@link MODEL_SECRETS}
 * (the order the proxy uses) found in the store or the environment. The
 * value is passed on, never printed.
 */
export async function probeModelSecret(
	l: Lookup,
): Promise<{ name: ModelSecretName; value: string; from: string } | null> {
	for (const name of MODEL_SECRETS) {
		const hit = await lookupSecret(name, l);
		if (hit) return { name, value: hit.value, from: hit.from };
	}
	return null;
}

/**
 * Step e's launcher in box mode: each probe spec gets {@link probeEnv} and
 * the model secret, then runs through the box launcher (BoxLauncher). The
 * box is deleted with its agents, so `find` has nothing left to archive.
 */
export function boxProbeLauncher(
	box: AgentLauncher,
	model: { name: ModelSecretName; value: string } | null,
): AgentLauncher & { find(executionId: string): Promise<string[]> } {
	return {
		run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult> {
			const { host: _local, ...rest } = spec;
			return box.run(
				{
					...rest,
					recipe: probeEnv(model?.name),
					env: model ? { [model.name]: model.value } : {},
				},
				signal,
			);
		},
		find: async () => [],
	};
}
