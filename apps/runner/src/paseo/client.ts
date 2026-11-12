/**
 * The runner's ONE adapter to Paseo (mm-210.85): every Paseo call of the
 * runner goes through {@link Paseo}, on the typed SDK (@getpaseo/client), one
 * connection per daemon. No `paseo` CLI process, no parsing of its stdout.
 * Tests pass their own {@link PaseoConnect} (test/paseo/fake.ts).
 *
 * The box daemon has its own connection over the box relay
 * (box/paseo-link.ts); the agent step there uses the same structured run
 * (agent.ts).
 */

import { type RunOutcome, runStructured, type StructuredRun } from "./agent.ts";
import {
	connectDaemon,
	type DaemonClient,
	PaseoUnreachable,
} from "./connect.ts";

export { PaseoUnreachable };

/** One provider as Paseo sees it on a host (`paseo provider ls`). */
export type ProviderState = {
	provider: string;
	/** Paseo's word: ready (`available` in the CLI), loading, error, unavailable. */
	status: "ready" | "loading" | "error" | "unavailable";
	enabled: boolean;
	/** The mode an agent gets when none is set; null: Paseo does not say. */
	defaultMode: string | null;
	modes: string[];
	/** Model ids Paseo lists for it; empty: not known (yet). */
	models: string[];
	/** Paseo's reason when not ready (e.g. "agy not found on PATH"). */
	error?: string;
};

/**
 * The provider's login as Paseo's diagnostic shows it
 * (`paseo provider diagnostic <p>`: `Auth: {...}`, `Status: Ready`).
 * Paseo gives the diagnostic as text only; these are the two facts read
 * from it. NOTE: Claude Code says loggedIn true for any token it holds,
 * also a wrong one (mm-210.80): logged in means a credential is PRESENT;
 * only a real prompt (doctor --deep) proves it is accepted.
 */
export type ProviderLogin = {
	/** null: the diagnostic does not say. */
	loggedIn: boolean | null;
	authMethod: string | null;
	/** The `Status:` line, e.g. "Ready"; null: none. */
	status: string | null;
};

/** A host registered on this machine's Paseo (the box hosts, mm-210.68). */
export type HostRow = {
	registrationId: string;
	label: string | null;
	metadata: Record<string, string>;
	/** online, connecting, offline, error, disabled. */
	status: string;
};

/** The Paseo calls the runner makes, on one daemon. */
export interface Paseo {
	/** For messages: `local (<home>)` or the host. */
	readonly where: string;
	providers(): Promise<ProviderState[]>;
	login(provider: string): Promise<ProviderLogin>;
	/** Ids of the agents with all these labels (archived ones too). */
	agentIds(labels: Record<string, string>): Promise<string[]>;
	/** One agent with a `{status, summary}` answer (agent.ts). */
	runAgent(
		o: StructuredRun,
		signal: AbortSignal,
		opts?: { onAgent?: (id: string) => void },
	): Promise<RunOutcome>;
	stopAgent(id: string): Promise<void>;
	archiveAgent(id: string): Promise<void>;
	hosts(): Promise<HostRow[]>;
	addHost(h: {
		connection: string;
		label: string;
		metadata: Record<string, string>;
	}): Promise<HostRow>;
	removeHost(registrationId: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * A connection to the daemon for `host` (default: the local home). Throws
 * {@link PaseoUnreachable} with Paseo's reason and a fix.
 */
export type PaseoConnect = (
	host?: string,
	o?: { reconnect?: boolean },
) => Promise<Paseo>;

/** Read `Auth: {json}` and `Status: X` from Paseo's diagnostic text. */
export function parseLogin(diagnostic: string): ProviderLogin {
	let loggedIn: boolean | null = null;
	let authMethod: string | null = null;
	const at = diagnostic.search(/^\s*Auth:\s*\{/m);
	if (at >= 0) {
		const from = diagnostic.indexOf("{", at);
		let depth = 0;
		for (let i = from; i < diagnostic.length; i++) {
			const ch = diagnostic[i];
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					const a = JSON.parse(diagnostic.slice(from, i + 1)) as {
						loggedIn?: unknown;
						authMethod?: unknown;
					};
					if (typeof a.loggedIn === "boolean") loggedIn = a.loggedIn;
					if (typeof a.authMethod === "string") authMethod = a.authMethod;
				} catch {}
				break;
			}
		}
	}
	if (loggedIn === null && /^\s*Auth:.*not logged in/im.test(diagnostic))
		loggedIn = false;
	const status = diagnostic.match(/^\s*Status:\s*(.+?)\s*$/m)?.[1] ?? null;
	return { loggedIn, authMethod, status };
}

/** The adapter over one SDK connection. */
export function paseoOver(c: DaemonClient, where: string): Paseo {
	return {
		where,
		async providers() {
			const s = await c.getProvidersSnapshot();
			return s.entries.map((e) => ({
				provider: e.provider,
				status: e.status,
				enabled: e.enabled,
				defaultMode: e.defaultModeId ?? null,
				modes: (e.modes ?? []).map((m) => m.id),
				models: (e.models ?? []).map((m) => m.id),
				...(e.error ? { error: e.error } : {}),
			}));
		},
		async login(provider) {
			const d = await c.getProviderDiagnostic(provider);
			return parseLogin(d.diagnostic ?? "");
		},
		async agentIds(labels) {
			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await c.fetchAgents({
					filter: { labels, includeArchived: true },
					page: { limit: 200, ...(cursor ? { cursor } : {}) },
				});
				for (const e of page.entries) {
					const l = (e.agent.labels ?? {}) as Record<string, string>;
					if (Object.entries(labels).every(([k, v]) => l[k] === v))
						ids.push(e.agent.id);
				}
				cursor = page.pageInfo.nextCursor ?? undefined;
			} while (cursor);
			return ids;
		},
		runAgent: (o, signal, opts) => runStructured(c, o, signal, opts),
		stopAgent: (id) => c.cancelAgent(id),
		async archiveAgent(id) {
			await c.archiveAgent(id);
		},
		async hosts() {
			const d = await c.listHosts();
			return d.hosts.map((h) => ({
				registrationId: h.registrationId,
				label: h.label,
				metadata: h.metadata,
				status: h.status,
			}));
		},
		async addHost(h) {
			const r = await c.addHost(h);
			return {
				registrationId: r.registrationId,
				label: r.label,
				metadata: r.metadata,
				status: r.status,
			};
		},
		removeHost: (id) => c.removeHost(id),
		close: () => c.close().catch(() => {}),
	};
}

/** The real {@link PaseoConnect}: the SDK, with the CLI's target and login rules. */
export const connectPaseo: PaseoConnect = async (host, o = {}) => {
	const { client, target } = await connectDaemon(host, {
		reconnect: o.reconnect ?? false,
	});
	return paseoOver(client, target.where);
};

/** `fn` on a fresh connection to `host`, closed after. */
export async function withPaseo<T>(
	connect: PaseoConnect,
	host: string | undefined,
	fn: (p: Paseo) => Promise<T>,
): Promise<T> {
	const p = await connect(host);
	try {
		return await fn(p);
	} finally {
		await p.close();
	}
}

/** One line for an error from a Paseo call. */
export function paseoMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object" && "message" in error)
		return String((error as { message: unknown }).message);
	return String(error);
}
