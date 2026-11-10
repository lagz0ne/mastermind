/**
 * Environments: named definitions of where and how an agent works (repo, ref,
 * requirements, setup, check, secret names, agent preference, instructions).
 * ONE document in JetStream KV (bucket `mm-config`, key `environments`),
 * written with compare-and-set by revision, like routing.
 *
 * Pure: validation and resolution. No I/O.
 */
import {
	type Bead,
	type DispatchEnv,
	type Environment,
	type EnvironmentAgent,
	envNameOf,
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

export const isEnvironmentName = (v: unknown): v is string =>
	typeof v === "string" && NAME.test(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check an untrusted document. Returns the clean document or the problems by
 * field. Unknown fields are dropped; missing lists become empty.
 */
export function validate(
	input: unknown,
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

		const repo = str("repo", true);
		if (repo && !NO_SPACE.test(repo)) err(`${at}.repo`, "no spaces in a URL");
		const ref = str("ref", false) || "main";
		if (!NO_SPACE.test(ref)) err(`${at}.ref`, "no spaces in a ref");
		const env: Environment = {
			name: typeof e.name === "string" ? e.name : "",
			description: str("description", false),
			repo,
			ref,
			requires: list("requires", NO_SPACE, "one capability, no spaces"),
			setup: list("setup"),
			check: list("check"),
			secrets: list("secrets", SECRET, "a name: letters, digits and '_'"),
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
		const instructions = str("instructions", false);
		if (instructions) env.instructions = instructions;
		environments.push(env);
	}
	return errors.length
		? { ok: false, errors }
		: { ok: true, doc: { environments } };
}

/** Read a stored value leniently: a broken document defines nothing. */
export function parseStored(value: unknown): EnvironmentsDoc {
	const v = validate(value);
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
		secrets: def.secrets,
	};
	const provider = labelValue(bead, PROVIDER_LABEL_PREFIX);
	if (provider) env.provider = provider;
	if (def.agent) env.agent = def.agent;
	if (def.instructions) env.instructions = def.instructions;
	return { ok: true, env };
}
