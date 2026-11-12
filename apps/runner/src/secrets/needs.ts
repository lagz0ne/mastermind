/**
 * Which secrets this runner needs, which it has, which are missing
 * (mm-210.51). Only NAMES are fetched, cached, shown and reported; values are
 * read from the local store at start and go only to the agent.
 *
 * Needed = the secret names of every environment this runner can be offered:
 * all environments, or only the bound ones when routing.json binds any (the
 * dispatcher then offers only those). Mastermind serves the names at
 * GET /api/runner/environments (service account credential).
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Routing } from "../routing.ts";
import type { SecretSource } from "./store.ts";

/**
 * One environment as the runner sees it: its name and secret names, and the
 * box runtime it asks for (`gvisor`; readiness checks the engine has it).
 */
export type EnvSecrets = { name: string; secrets: string[]; runtime?: string };

/** The environments' secret names, as fetched (and cached) at `at`. */
export type Needs = { at: string; environments: EnvSecrets[] };

export class NeedsError extends Error {
	override name = "NeedsError";
}

/** `needs.json` next to the secrets file: the last fetched names, for offline use. */
export function needsPath(secretsFile: string): string {
	return join(dirname(secretsFile), "needs.json");
}

const strings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((s) => typeof s === "string");

function parseEnvironments(v: unknown): EnvSecrets[] {
	const list = (v as { environments?: unknown })?.environments;
	if (!Array.isArray(list)) throw new NeedsError("bad answer: no environments");
	return list
		.filter(
			(e): e is EnvSecrets =>
				!!e && typeof e.name === "string" && strings(e.secrets),
		)
		.map((e) => ({
			name: e.name,
			secrets: [...e.secrets],
			...(typeof e.runtime === "string" && e.runtime
				? { runtime: e.runtime }
				: {}),
		}));
}

/** GET <mastermind>/api/runner/environments with the runner's credential. */
export async function fetchNeeds(
	mastermindUrl: string,
	credential: string,
	opts: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {},
): Promise<Needs> {
	const url = `${mastermindUrl.replace(/\/+$/, "")}/api/runner/environments`;
	let res: Response;
	try {
		res = await (opts.fetch ?? fetch)(url, {
			headers: { authorization: `Bearer ${credential}` },
			signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new NeedsError(
			`Mastermind does not answer at ${mastermindUrl}: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new NeedsError(
			res.status === 401
				? "Mastermind refuses this runner's credential"
				: res.status === 404
					? "this Mastermind does not serve /api/runner/environments yet"
					: `Mastermind answered ${res.status} for the environments`,
		);
	}
	return {
		at: (opts.now?.() ?? new Date()).toISOString(),
		environments: parseEnvironments(await res.json()),
	};
}

export async function loadNeeds(path: string): Promise<Needs | null> {
	try {
		const v = await Bun.file(path).json();
		return { at: String(v.at), environments: parseEnvironments(v) };
	} catch {
		return null;
	}
}

export async function saveNeeds(path: string, n: Needs): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(n, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

/** Secret name → the environments (this runner can get) that need it. */
export function neededSecrets(
	needs: Needs,
	routing: Pick<Routing, "environments" | "implicit">,
): Map<string, string[]> {
	const bound = Object.keys(routing.environments);
	const only = !routing.implicit && bound.length ? new Set(bound) : null;
	const out = new Map<string, string[]>();
	for (const e of needs.environments) {
		if (only && !only.has(e.name)) continue;
		for (const s of e.secrets) out.set(s, [...(out.get(s) ?? []), e.name]);
	}
	return out;
}

/** Where a value was found: the store, an env var, or a file (routing.json source). */
export type SecretFrom = "store" | `env:${string}` | `file:${string}`;

export type Lookup = {
	/** Stored values (SecretSource.load()). */
	store: Record<string, string>;
	/** The runner's process environment. */
	env: Record<string, string | undefined>;
	/** routing.json `environments.<name>.env`: secret name → source. */
	binding?: Record<string, string>;
};

/**
 * One secret's value and where it came from, or null. A source in
 * routing.json wins (`env:VAR`, `VAR` or `file:/path`); else the store; else
 * the env var of the same name.
 */
export async function lookupSecret(
	name: string,
	l: Lookup,
): Promise<{ value: string; from: SecretFrom } | null> {
	const src = l.binding?.[name];
	if (src?.startsWith("file:")) {
		const f = Bun.file(src.slice(5));
		if (!(await f.exists())) return null;
		const value = (await f.text()).trim();
		return value ? { value, from: src as SecretFrom } : null;
	}
	if (src) {
		const v = src.startsWith("env:") ? src.slice(4) : src;
		const value = l.env[v];
		return value ? { value, from: `env:${v}` } : null;
	}
	const stored = l.store[name];
	if (stored) return { value: stored, from: "store" };
	const value = l.env[name];
	return value ? { value, from: `env:${name}` } : null;
}

/** The values of `names` (for the agent only), and the names that have none. */
export async function resolveSecrets(
	names: string[],
	l: Lookup,
): Promise<{ values: Record<string, string>; missing: string[] }> {
	const values: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of names) {
		const hit = await lookupSecret(name, l);
		if (hit) values[name] = hit.value;
		else missing.push(name);
	}
	return { values, missing };
}

/** The decline reason of a dispatch that needs secrets this runner lacks. */
export function missingReason(missing: string[]): string {
	return `missing secrets: ${missing.join(", ")} (on the runner: ${missing.map((m) => `mastermind-runner secrets set ${m}`).join("; ")})`;
}

/** One row of `secrets list`: never a value. */
export type SecretRow = {
	name: string;
	/** Environments that need it; empty: stored but not needed. */
	neededBy: string[];
	present: boolean;
	from: SecretFrom | null;
};

/** Every needed or stored secret, needed ones first, then by name. */
export async function secretRows(
	needed: Map<string, string[]>,
	source: SecretSource,
	env: Record<string, string | undefined>,
	routing: Pick<Routing, "environments">,
): Promise<SecretRow[]> {
	const store = await source.load();
	const rows: SecretRow[] = [];
	for (const [name, envs] of needed) {
		let from: SecretFrom | null = null;
		let present = true;
		for (const e of envs) {
			const hit = await lookupSecret(name, {
				store,
				env,
				binding: routing.environments[e]?.env,
			});
			if (!hit) present = false;
			else from ??= hit.from;
		}
		rows.push({ name, neededBy: envs, present, from: present ? from : null });
	}
	for (const name of Object.keys(store))
		if (!needed.has(name))
			rows.push({ name, neededBy: [], present: true, from: "store" });
	return rows.sort(
		(a, b) =>
			Number(!a.neededBy.length) - Number(!b.neededBy.length) ||
			a.name.localeCompare(b.name),
	);
}

/** What the runner reports in its diagnostics: names only. */
export type SecretsDiagnostics = {
	needed: string[];
	missing: string[];
	/** When the needed names were fetched; null: never (unknown). */
	needsAt: string | null;
	/** Why the needed names are unknown or old, if they are. */
	problem?: string;
};

export function secretsDiagnostics(
	rows: SecretRow[],
	needsAt: string | null,
	problem?: string,
): SecretsDiagnostics {
	const needed = rows.filter((r) => r.neededBy.length);
	return {
		needed: needed.map((r) => r.name),
		missing: needed.filter((r) => !r.present).map((r) => r.name),
		needsAt,
		...(problem ? { problem } : {}),
	};
}
