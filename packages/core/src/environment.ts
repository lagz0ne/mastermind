/**
 * An environment is the recipe of a box: the throwaway container in which one
 * agent works on one item (docs/design/box.html, section 3). Defined once in
 * Mastermind (`/environments`, KV), referenced by an item with the label
 * `env:<name>`, resolved by the dispatcher into `DispatchEnv`.
 */

/** Resource limits of one box. */
export type EnvironmentLimits = {
	/** CPU cores (fractions allowed). */
	cpu: number;
	memoryMb: number;
	/** The box is stopped and thrown away after this many minutes. */
	timeoutMin: number;
};

/** Network of a box: open, or only these hosts (`host` or `host:port`, `*.host`). */
export type EnvironmentNetwork = "open" | { allow: string[] };

/** The agent provider in the box, and the secret that logs it in. */
export type EnvironmentProvider = {
	/** For example `claude`. */
	name: string;
	/** Name of the secret with the provider login (a token). Never the value. */
	auth?: string;
};

/** How code leaves the box: a pull request, a pushed branch, or nothing. */
export type EnvironmentOutput = {
	kind: "pr" | "branch" | "none";
	/** Branch the work starts from and the pull request targets; default: the ref. */
	base?: string;
};

export const OUTPUT_KINDS = ["pr", "branch", "none"] as const;

/** Which agent an environment prefers (before box recipes; `mode` still applies). */
export type EnvironmentAgent = { provider?: string; mode?: string };

export type Environment = {
	/** A single NATS subject token: letters, digits, '_' and '-'. */
	name: string;
	description: string;
	// --- the box
	/** Base image. Empty: the runner's default box image. */
	image: string;
	/** Lines baked into a cached image on top of `image` (for example `RUN apt-get install -y jq`, or a shell command). */
	tools: string[];
	/** Shell commands run in each new box after the checkout (install, build, seed). */
	setup: string[];
	/** Shell commands that must pass before the agent starts. */
	check: string[];
	limits: EnvironmentLimits;
	network: EnvironmentNetwork;
	// --- what goes in
	/** Git remote URL of the repo to work in. */
	repo: string;
	/** Default branch, tag or commit; an item's `ref:` label overrides it. */
	ref: string;
	/** Capabilities the runner must have (for example `docker`). */
	requires: string[];
	/** Names of secrets the box gets. Never the values. */
	secrets: string[];
	provider?: EnvironmentProvider;
	/** Older preference; `mode` is still passed to the runner. */
	agent?: EnvironmentAgent;
	// --- what comes out
	output: EnvironmentOutput;
	/** Text added to every prompt for this environment. */
	instructions?: string;
};

export const DEFAULT_LIMITS: EnvironmentLimits = {
	cpu: 2,
	memoryMb: 4096,
	timeoutMin: 60,
};
export const DEFAULT_NETWORK: EnvironmentNetwork = "open";
export const DEFAULT_OUTPUT: EnvironmentOutput = { kind: "none" };

/** Every secret name a box of this recipe needs: `secrets` plus the provider login. */
export function requiredSecrets(
	env: Pick<Environment, "secrets"> & { provider?: EnvironmentProvider },
): string[] {
	const names = [...env.secrets];
	if (env.provider?.auth) names.push(env.provider.auth);
	return [...new Set(names)];
}

/** What goes into the box image: the runner caches images by its hash. */
export type BoxRecipe = Pick<Environment, "image" | "tools">;
