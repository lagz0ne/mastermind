/**
 * Environments in the browser: the document the api serves
 * (GET/PUT /api/environments), pure edits on it, and the api calls.
 */
import {
	DEFAULT_LIMITS,
	type Environment,
	type EnvironmentOutput,
} from "@mastermind/core";

export type EnvironmentsDoc = { environments: Environment[] };
export type Environments = EnvironmentsDoc & { revision: number };
export type FieldError = { field: string; message: string };

export const ENV_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The fields a form edits; lists are text (one per line, or words). */
export type EnvForm = {
	name: string;
	description: string;
	// the box
	image: string;
	tools: string;
	setup: string;
	check: string;
	cpu: string;
	memoryMb: string;
	timeoutMin: string;
	/** Empty or `open`: open. Else allowed hosts, space separated. */
	network: string;
	// what goes in
	repo: string;
	ref: string;
	requires: string;
	secrets: string;
	/** Provider name, for example claude. */
	provider: string;
	/** Name of the provider login secret. */
	providerAuth: string;
	mode: string;
	// what comes out
	outputKind: EnvironmentOutput["kind"];
	outputBase: string;
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
		image: e.image,
		tools: e.tools.join("\n"),
		setup: e.setup.join("\n"),
		check: e.check.join("\n"),
		cpu: String(e.limits.cpu),
		memoryMb: String(e.limits.memoryMb),
		timeoutMin: String(e.limits.timeoutMin),
		network: e.network === "open" ? "open" : e.network.allow.join(" "),
		repo: e.repo,
		ref: e.ref,
		requires: e.requires.join(" "),
		secrets: e.secrets.join(" "),
		provider: e.provider?.name ?? e.agent?.provider ?? "",
		providerAuth: e.provider?.auth ?? "",
		mode: e.agent?.mode ?? "",
		outputKind: e.output.kind,
		outputBase: e.output.base ?? "",
		instructions: e.instructions ?? "",
	};
}

/** A number typed in the form; empty: the default. Not a number: NaN (see formErrors). */
const numberOr = (text: string, fallback: number) =>
	text.trim() === "" ? fallback : Number(text.trim());

export function fromForm(f: EnvForm): Environment {
	const hosts = words(f.network);
	const e: Environment = {
		name: f.name.trim(),
		description: f.description.trim(),
		image: f.image.trim(),
		tools: lines(f.tools),
		setup: lines(f.setup),
		check: lines(f.check),
		limits: {
			cpu: numberOr(f.cpu, DEFAULT_LIMITS.cpu),
			memoryMb: numberOr(f.memoryMb, DEFAULT_LIMITS.memoryMb),
			timeoutMin: numberOr(f.timeoutMin, DEFAULT_LIMITS.timeoutMin),
		},
		network:
			hosts.length === 0 || (hosts.length === 1 && hosts[0] === "open")
				? "open"
				: { allow: hosts },
		repo: f.repo.trim(),
		ref: f.ref.trim() || "main",
		requires: words(f.requires),
		secrets: words(f.secrets),
		output: {
			kind: f.outputKind,
			...(f.outputBase.trim() ? { base: f.outputBase.trim() } : {}),
		},
	};
	const provider = f.provider.trim();
	const auth = f.providerAuth.trim();
	if (provider)
		e.provider = auth ? { name: provider, auth } : { name: provider };
	if (f.mode.trim()) e.agent = { mode: f.mode.trim() };
	if (f.instructions.trim()) e.instructions = f.instructions.trim();
	return e;
}

/** Problems the browser can see before a save: numbers that are not numbers. */
export function formErrors(f: EnvForm): Partial<Record<keyof EnvForm, string>> {
	const out: Partial<Record<keyof EnvForm, string>> = {};
	for (const k of ["cpu", "memoryMb", "timeoutMin"] as const)
		if (f[k].trim() !== "" && !Number.isFinite(Number(f[k].trim())))
			out[k] = "a number";
	return out;
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
		image: "",
		tools: [],
		setup: [],
		check: [],
		limits: { ...DEFAULT_LIMITS },
		network: "open",
		repo: "",
		ref: "main",
		requires: [],
		secrets: [],
		output: { kind: "none" },
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
		const [head = "", sub, index] = e.field.slice(prefix.length).split(".");
		const { key, item } = formKey(head, sub, index);
		const at = item === undefined ? "" : ` (${Number(item) + 1})`;
		out[key] = out[key]
			? `${out[key]}; ${e.message}${at}`
			: `${e.message}${at}`;
	}
	return out;
}

/** The form field of a server field path: `limits.cpu` → cpu, `setup.0` → setup (item 0). */
function formKey(
	head: string,
	sub: string | undefined,
	index: string | undefined,
): { key: keyof EnvForm; item?: string } {
	switch (head) {
		case "limits":
			return { key: (sub ?? "cpu") as keyof EnvForm };
		case "network":
			return { key: "network", item: index };
		case "provider":
			return { key: sub === "auth" ? "providerAuth" : "provider" };
		case "agent":
			return { key: sub === "provider" ? "provider" : "mode" };
		case "output":
			return { key: sub === "base" ? "outputBase" : "outputKind" };
		default:
			return { key: head as keyof EnvForm, item: sub };
	}
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
