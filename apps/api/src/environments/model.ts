/**
 * Environments: named box recipes (image, tools, setup, check, limits,
 * network, repo, ref, secret names, provider login, output, instructions).
 * ONE document in JetStream KV (bucket `mm-config`, key `environments`),
 * written with compare-and-set by revision, like routing.
 *
 * Pure: validation and resolution. No I/O.
 */
import {
	ALLOW_HOST_FIELDS,
	type Bead,
	type BoxRecipe,
	DEFAULT_LIMITS,
	DEFAULT_NETWORK,
	DEFAULT_OUTPUT,
	type DevcontainerSettings,
	type DispatchEnv,
	type Environment,
	type EnvironmentAgent,
	type EnvironmentLimits,
	type EnvironmentNetwork,
	type EnvironmentOutput,
	envNameOf,
	OUTPUT_KINDS,
	requiredSecrets,
} from "@mastermind/core";
import { requirementsOf } from "@mastermind/router";
import {
	envOf,
	PROVIDER_LABEL_PREFIX,
	REF_LABEL_PREFIX,
	REPO_LABEL_PREFIX,
} from "../beads/env.ts";

export const ENVIRONMENTS_KEY = "environments";

export type EnvironmentsDoc = { environments: Environment[] };

export const EMPTY_ENVIRONMENTS: EnvironmentsDoc = { environments: [] };

/** The document with the KV revision it was read at (0: never written). */
export type EnvironmentsState = { doc: EnvironmentsDoc; revision: number };

/** One problem, tied to a field path such as `environments.0.repo`. */
export type FieldError = { field: string; message: string };

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const NO_SPACE = /^\S+$/;
const HOST = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/;

/**
 * The image an environment gets when it names none: config
 * `MASTERMIND_BOX_IMAGE` (no registry is fixed in code). Empty: the runner's
 * own default box image.
 */
export function defaultBoxImage(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.MASTERMIND_BOX_IMAGE?.trim() ?? "";
}

/** sha256 (hex) of what goes into the box image: the runner's cache key. */
export function recipeHash(recipe: BoxRecipe): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ image: recipe.image, tools: recipe.tools }))
		.digest("hex");
}

export const isEnvironmentName = (v: unknown): v is string =>
	typeof v === "string" && NAME.test(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check an untrusted document. Returns the clean document or the problems by
 * field. Unknown fields are dropped. Missing fields get defaults, so documents
 * written before box recipes still load: lists empty, `image` the default box
 * image, default limits, open network, output none.
 */
export function validate(
	input: unknown,
	defaultImage: string = defaultBoxImage(),
): { ok: true; doc: EnvironmentsDoc } | { ok: false; errors: FieldError[] } {
	const errors: FieldError[] = [];
	const err = (field: string, message: string) =>
		errors.push({ field, message });
	if (!isObject(input))
		return {
			ok: false,
			errors: [{ field: "", message: "body must be an object" }],
		};
	if (!Array.isArray(input.environments)) {
		err("environments", "environments must be a list");
		return { ok: false, errors };
	}
	const environments: Environment[] = [];
	const names = new Set<string>();
	for (const [i, e] of input.environments.entries()) {
		const at = `environments.${i}`;
		if (!isObject(e)) {
			err(at, "must be an object");
			continue;
		}
		if (!isEnvironmentName(e.name))
			err(`${at}.name`, "1-64 letters, digits, '_' or '-'");
		else if (names.has(e.name)) err(`${at}.name`, `${e.name} is used twice`);
		else names.add(e.name);

		const str = (key: string, required: boolean): string => {
			const v = e[key];
			if (v === undefined || v === null || v === "") {
				if (required) err(`${at}.${key}`, "required");
				return "";
			}
			if (typeof v !== "string") {
				err(`${at}.${key}`, "must be text");
				return "";
			}
			return v.trim();
		};
		const list = (key: string, check?: RegExp, what?: string): string[] => {
			const v = e[key] ?? [];
			if (!Array.isArray(v)) {
				err(`${at}.${key}`, "must be a list");
				return [];
			}
			const out: string[] = [];
			for (const [j, item] of v.entries()) {
				if (typeof item !== "string" || item.trim() === "") {
					err(`${at}.${key}.${j}`, "must be non-empty text");
					continue;
				}
				const t = item.trim();
				if (check && !check.test(t)) {
					err(`${at}.${key}.${j}`, what ?? "invalid");
					continue;
				}
				out.push(t);
			}
			return [...new Set(out)];
		};

		const num = (
			obj: Record<string, unknown>,
			key: keyof EnvironmentLimits,
			min: number,
			max: number,
			whole: boolean,
		): number => {
			const v = obj[key] ?? DEFAULT_LIMITS[key];
			if (
				typeof v !== "number" ||
				!Number.isFinite(v) ||
				v < min ||
				v > max ||
				(whole && !Number.isInteger(v))
			) {
				err(
					`${at}.limits.${key}`,
					`${whole ? "a whole number" : "a number"} from ${min} to ${max}`,
				);
				return DEFAULT_LIMITS[key];
			}
			return v;
		};

		const repo = str("repo", true);
		if (repo && !NO_SPACE.test(repo)) err(`${at}.repo`, "no spaces in a URL");
		const ref = str("ref", false) || "main";
		if (!NO_SPACE.test(ref)) err(`${at}.ref`, "no spaces in a ref");
		const image = str("image", false) || defaultImage;
		if (image && !NO_SPACE.test(image))
			err(`${at}.image`, "no spaces in an image name");

		let limits: EnvironmentLimits = { ...DEFAULT_LIMITS };
		if (e.limits !== undefined && e.limits !== null) {
			if (!isObject(e.limits)) err(`${at}.limits`, "must be an object");
			else
				limits = {
					cpu: num(e.limits, "cpu", 0.1, 64, false),
					memoryMb: num(e.limits, "memoryMb", 256, 262_144, true),
					timeoutMin: num(e.limits, "timeoutMin", 1, 1440, true),
				};
		}

		let network: EnvironmentNetwork = DEFAULT_NETWORK;
		if (e.network !== undefined && e.network !== null && e.network !== "open") {
			if (!isObject(e.network) || !Array.isArray(e.network.allow))
				err(`${at}.network`, "'open' or {allow: [hosts]}");
			else {
				const allow: string[] = [];
				for (const [j, h] of e.network.allow.entries()) {
					if (typeof h !== "string" || !HOST.test(h.trim()))
						err(`${at}.network.allow.${j}`, "a host, host:port or *.host");
					else allow.push(h.trim().toLowerCase());
				}
				network = { allow: [...new Set(allow)] };
			}
		}

		let output: EnvironmentOutput = { ...DEFAULT_OUTPUT };
		if (e.output !== undefined && e.output !== null) {
			const o = e.output;
			if (!isObject(o) || !OUTPUT_KINDS.includes(o.kind as never))
				err(`${at}.output.kind`, "pr, branch or none");
			else {
				output = { kind: o.kind as EnvironmentOutput["kind"] };
				if (o.base !== undefined && o.base !== null && o.base !== "") {
					if (typeof o.base !== "string" || !NO_SPACE.test(o.base))
						err(`${at}.output.base`, "a branch name, no spaces");
					else output.base = o.base;
				}
			}
		}
		if (output.kind !== "none" && repo === "")
			err(`${at}.output.kind`, "a pull request or branch needs a repo");

		const env: Environment = {
			name: typeof e.name === "string" ? e.name : "",
			description: str("description", false),
			image,
			tools: list("tools"),
			setup: list("setup"),
			check: list("check"),
			limits,
			network,
			repo,
			ref,
			requires: list("requires", NO_SPACE, "one capability, no spaces"),
			secrets: list("secrets", SECRET, "a name: letters, digits and '_'"),
			output,
		};
		if (e.agent !== undefined && e.agent !== null) {
			if (!isObject(e.agent)) err(`${at}.agent`, "must be an object");
			else {
				const agent: EnvironmentAgent = {};
				for (const k of ["provider", "mode"] as const) {
					const v = e.agent[k];
					if (v === undefined || v === null || v === "") continue;
					if (typeof v !== "string" || !NO_SPACE.test(v))
						err(`${at}.agent.${k}`, "one word, no spaces");
					else agent[k] = v;
				}
				if (agent.provider || agent.mode) env.agent = agent;
			}
		}
		if (e.provider !== undefined && e.provider !== null && e.provider !== "") {
			const p = e.provider;
			if (!isObject(p)) err(`${at}.provider`, "must be an object");
			else {
				const name = typeof p.name === "string" ? p.name.trim() : "";
				if (!name || !NO_SPACE.test(name))
					err(`${at}.provider.name`, "one word, for example claude");
				const auth = typeof p.auth === "string" ? p.auth.trim() : "";
				if (
					p.auth !== undefined &&
					p.auth !== null &&
					p.auth !== "" &&
					!SECRET.test(auth)
				)
					err(`${at}.provider.auth`, "a secret name: letters, digits and '_'");
				if (name) env.provider = auth ? { name, auth } : { name };
			}
		} else if (env.agent?.provider) {
			// Before box recipes the provider was a preference in `agent`.
			env.provider = { name: env.agent.provider };
		}
		const instructions = str("instructions", false);
		if (instructions) env.instructions = instructions;
		if (e.devcontainer !== undefined && e.devcontainer !== null) {
			const dc = devcontainerOf(e.devcontainer, `${at}.devcontainer`, err);
			if (dc) env.devcontainer = dc;
		}
		environments.push(env);
	}
	return errors.length
		? { ok: false, errors }
		: { ok: true, doc: { environments } };
}

/** Most bytes of an environment's own devcontainer.json. */
export const MAX_DEVCONTAINER_CONFIG = 64 * 1024;

/**
 * The devcontainer settings of an environment. The own config must be a
 * devcontainer.json object (JSON with comments) with image or build, and no
 * Docker Compose. The runner checks it again and builds it.
 */
export function devcontainerOf(
	v: unknown,
	at: string,
	err: (field: string, message: string) => void,
): DevcontainerSettings | null {
	if (!isObject(v)) {
		err(at, "must be an object");
		return null;
	}
	const dc: DevcontainerSettings = {};
	if (v.use !== undefined && v.use !== null && v.use !== "auto") {
		if (v.use !== "none") err(`${at}.use`, "auto or none");
		else dc.use = "none";
	}
	if (typeof v.config === "string" && v.config.trim()) {
		const text = v.config.trim();
		let cfg: unknown;
		try {
			cfg = Bun.JSONC.parse(text);
		} catch (error) {
			err(
				`${at}.config`,
				`not valid JSON: ${error instanceof Error ? error.message : error}`,
			);
		}
		if (text.length > MAX_DEVCONTAINER_CONFIG)
			err(`${at}.config`, `at most ${MAX_DEVCONTAINER_CONFIG / 1024} KiB`);
		else if (cfg !== undefined) {
			if (!isObject(cfg)) err(`${at}.config`, "a devcontainer.json object");
			else if ("dockerComposeFile" in cfg)
				err(
					`${at}.config`,
					"Docker Compose is not supported in a box; use image or build.dockerfile",
				);
			else if (!("image" in cfg) && !("build" in cfg))
				err(`${at}.config`, "needs image or build.dockerfile");
			else dc.config = text;
		}
	} else if (v.config !== undefined && v.config !== null && v.config !== "")
		err(`${at}.config`, "must be text");
	if (typeof v.configPath === "string" && v.configPath.trim()) {
		const p = v.configPath.trim();
		if (!NO_SPACE.test(p) || p.startsWith("/") || p.split("/").includes(".."))
			err(
				`${at}.configPath`,
				"a path in the repo (no spaces, no '..'), or a folder name under .devcontainer/",
			);
		else dc.configPath = p;
	} else if (
		v.configPath !== undefined &&
		v.configPath !== null &&
		v.configPath !== ""
	)
		err(`${at}.configPath`, "must be text");
	if (v.allowHost !== undefined && v.allowHost !== null) {
		const allowed: readonly string[] = ALLOW_HOST_FIELDS;
		if (!Array.isArray(v.allowHost)) err(`${at}.allowHost`, "must be a list");
		else {
			const out: string[] = [];
			for (const [j, f] of v.allowHost.entries()) {
				if (typeof f !== "string" || !allowed.includes(f))
					err(`${at}.allowHost.${j}`, `one of: ${allowed.join(", ")}`);
				else out.push(f);
			}
			if (out.length) dc.allowHost = [...new Set(out)];
		}
	}
	return Object.keys(dc).length ? dc : null;
}

/** Read a stored value leniently: a broken document defines nothing. */
export function parseStored(
	value: unknown,
	defaultImage: string = defaultBoxImage(),
): EnvironmentsDoc {
	const v = validate(value, defaultImage);
	return v.ok ? v.doc : EMPTY_ENVIRONMENTS;
}

export function environmentNamed(
	doc: EnvironmentsDoc,
	name: string,
): Environment | null {
	return doc.environments.find((e) => e.name === name) ?? null;
}

export type EnvResolution =
	| { ok: true; env: DispatchEnv }
	| { ok: false; reason: string };

function labelValue(bead: Pick<Bead, "labels">, prefix: string) {
	const label = bead.labels.find(
		(l) => l.startsWith(prefix) && l.length > prefix.length,
	);
	return label?.slice(prefix.length);
}

/** How {@link resolveEnv} treats a bead that names no environment. */
export type ResolveOptions = {
	/** The default from routing (rule, then queue); used without an env: label. */
	fallback?: string | null;
	/**
	 * Nothing saved yet (revision 0): a bead without a name dispatches the old
	 * way, from its labels, as before environments existed.
	 */
	open?: boolean;
};

/**
 * The environment of a dispatch. The bead's `env:<name>` label wins, else the
 * routing default. A per-bead `ref:` label overrides the ref; `req:` labels
 * add requirements; a `provider:` label is kept. A bead with no name but the
 * old `repo:` label is read the old way. Unknown or missing: not dispatched,
 * with the reason.
 */
export function resolveEnv(
	bead: Pick<Bead, "labels">,
	doc: EnvironmentsDoc,
	opts: ResolveOptions = {},
): EnvResolution {
	const name = envNameOf(bead) ?? opts.fallback ?? null;
	if (!name) {
		if (opts.open || labelValue(bead, REPO_LABEL_PREFIX))
			return { ok: true, env: envOf(bead) };
		return {
			ok: false,
			reason:
				"no environment: add the label env:<name>, or give its queue a default environment",
		};
	}
	const def = environmentNamed(doc, name);
	if (!def)
		return {
			ok: false,
			reason: `environment ${name} is not defined (see /environments)`,
		};
	const env: DispatchEnv = {
		name: def.name,
		repo: def.repo,
		ref: labelValue(bead, REF_LABEL_PREFIX) ?? def.ref,
		requires: [...new Set([...def.requires, ...requirementsOf(bead)])],
		setup: def.setup,
		check: def.check,
		// The provider login is one more secret the box needs.
		secrets: requiredSecrets(def),
		image: def.image,
		tools: def.tools,
		recipeHash: recipeHash(def),
		limits: def.limits,
		network: def.network,
		output: def.output,
	};
	const provider = labelValue(bead, PROVIDER_LABEL_PREFIX);
	if (provider) env.provider = provider;
	if (def.provider) env.providerLogin = def.provider;
	// The runner reads the provider preference from `agent` (mm-210.31).
	const agent: EnvironmentAgent = {
		...def.agent,
		...(def.provider ? { provider: def.provider.name } : {}),
	};
	if (agent.provider || agent.mode) env.agent = agent;
	if (def.instructions) env.instructions = def.instructions;
	if (def.devcontainer) env.devcontainer = def.devcontainer;
	return { ok: true, env };
}
