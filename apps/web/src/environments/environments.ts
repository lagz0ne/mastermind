/**
 * Environments in the browser: the document the api serves
 * (GET/PUT /api/environments), pure edits on it, and the api calls.
 */
import type { Environment } from "@mastermind/core";

export type EnvironmentsDoc = { environments: Environment[] };
export type Environments = EnvironmentsDoc & { revision: number };
export type FieldError = { field: string; message: string };

export const ENV_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The fields a form edits; lists are text (one per line, or words). */
export type EnvForm = {
	name: string;
	description: string;
	repo: string;
	ref: string;
	requires: string;
	setup: string;
	check: string;
	secrets: string;
	provider: string;
	mode: string;
	instructions: string;
};

const words = (text: string) => [
	...new Set(text.split(/[\s,]+/).filter(Boolean)),
];
const lines = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

export function toForm(e: Environment): EnvForm {
	return {
		name: e.name,
		description: e.description,
		repo: e.repo,
		ref: e.ref,
		requires: e.requires.join(" "),
		setup: e.setup.join("\n"),
		check: e.check.join("\n"),
		secrets: e.secrets.join(" "),
		provider: e.agent?.provider ?? "",
		mode: e.agent?.mode ?? "",
		instructions: e.instructions ?? "",
	};
}

export function fromForm(f: EnvForm): Environment {
	const e: Environment = {
		name: f.name.trim(),
		description: f.description.trim(),
		repo: f.repo.trim(),
		ref: f.ref.trim() || "main",
		requires: words(f.requires),
		setup: lines(f.setup),
		check: lines(f.check),
		secrets: words(f.secrets),
	};
	const provider = f.provider.trim();
	const mode = f.mode.trim();
	if (provider || mode)
		e.agent = { ...(provider ? { provider } : {}), ...(mode ? { mode } : {}) };
	if (f.instructions.trim()) e.instructions = f.instructions.trim();
	return e;
}

/** A new environment with a free name (`new`, `new-2`, ...). */
export function addEnvironment(doc: EnvironmentsDoc): {
	doc: EnvironmentsDoc;
	index: number;
} {
	const taken = new Set(doc.environments.map((e) => e.name));
	let name = "new";
	for (let n = 2; taken.has(name); n++) name = `new-${n}`;
	const env: Environment = {
		name,
		description: "",
		repo: "",
		ref: "main",
		requires: [],
		setup: [],
		check: [],
		secrets: [],
	};
	return {
		doc: { environments: [...doc.environments, env] },
		index: doc.environments.length,
	};
}

export function setEnvironment(
	doc: EnvironmentsDoc,
	i: number,
	env: Environment,
): EnvironmentsDoc {
	return {
		environments: doc.environments.map((e, k) => (k === i ? env : e)),
	};
}

export function removeEnvironment(
	doc: EnvironmentsDoc,
	i: number,
): EnvironmentsDoc {
	return { environments: doc.environments.filter((_, k) => k !== i) };
}

/** Number of environments added, removed or changed. */
export function changes(a: EnvironmentsDoc, b: EnvironmentsDoc): number {
	let n = 0;
	const len = Math.max(a.environments.length, b.environments.length);
	for (let i = 0; i < len; i++)
		if (JSON.stringify(a.environments[i]) !== JSON.stringify(b.environments[i]))
			n++;
	return n;
}

/**
 * Server errors of environment `i`, by form field (`environments.2.setup.0`
 * → `setup`). Joined when a field has several.
 */
export function errorsFor(
	errors: readonly FieldError[],
	i: number,
): Partial<Record<keyof EnvForm, string>> {
	const out: Partial<Record<keyof EnvForm, string>> = {};
	const prefix = `environments.${i}.`;
	for (const e of errors) {
		if (!e.field.startsWith(prefix)) continue;
		const parts = e.field.slice(prefix.length).split(".");
		const key = (
			parts[0] === "agent" ? (parts[1] ?? "provider") : parts[0]
		) as keyof EnvForm;
		const at =
			parts[0] !== "agent" && parts[1] ? ` (${Number(parts[1]) + 1})` : "";
		out[key] = out[key]
			? `${out[key]}; ${e.message}${at}`
			: `${e.message}${at}`;
	}
	return out;
}

/** Indexes of environments that have a server error. */
export function erroredIndexes(errors: readonly FieldError[]): Set<number> {
	const out = new Set<number>();
	for (const e of errors) {
		const m = /^environments\.(\d+)/.exec(e.field);
		if (m) out.add(Number(m[1]));
	}
	return out;
}

// --- api ------------------------------------------------------------------

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly status: number,
		message: string,
		readonly body: Record<string, unknown> = {},
	) {
		super(message);
	}
}

type Fetch = typeof fetch;
let csrf: string | null = null;

async function call<T>(
	method: "GET" | "PUT",
	body: unknown,
	fetcher: Fetch,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (method !== "GET") {
		if (!csrf) {
			const me = await fetcher("/api/auth/me", { credentials: "same-origin" });
			// Without auth (local dev) there is no CSRF token and none is needed.
			csrf = me.ok ? (((await me.json()) as { csrf?: string }).csrf ?? "") : "";
		}
		if (csrf) headers["x-csrf-token"] = csrf;
		headers["content-type"] = "application/json";
	}
	const res = await fetcher("/api/environments", {
		method,
		headers,
		credentials: "same-origin",
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
	const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<
		string,
		unknown
	>;
	if (res.status === 403) csrf = null;
	if (!res.ok)
		throw new ApiError(
			res.status,
			typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
			data,
		);
	return data as T;
}

export const getEnvironments = (fetcher: Fetch = fetch) =>
	call<Environments>("GET", undefined, fetcher);

/** 409: ApiError with body.current. 400: ApiError with body.errors. */
export const saveEnvironments = (
	doc: EnvironmentsDoc,
	revision: number,
	fetcher: Fetch = fetch,
) => call<Environments>("PUT", { ...doc, revision }, fetcher);
