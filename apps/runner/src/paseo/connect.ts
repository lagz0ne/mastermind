/**
 * Which Paseo daemon the runner talks to, and how it logs in: the same rules
 * as the paseo CLI 0.15.4 (cli utils/daemon-target.js, utils/client.js), so
 * `--paseo-host`, PASEO_HOST, PASEO_HOME and PASEO_PASSWORD mean what they
 * mean for `paseo`:
 *
 * - a host (`--paseo-host`, else PASEO_HOST): that endpoint
 *   (`host:port`, `tcp://...`, `unix://<socket>`, `/path/to/socket`);
 * - else the local home (PASEO_HOME, default ~/.paseo): the address in its
 *   `paseo.pid` (`listen`); no file or no address: the daemon is not running.
 *
 * Credential: a password in the host URI, else PASEO_PASSWORD, else the
 * home's `local-credential` file when the target is the address that home's
 * daemon listens on (the daemon wrote that file for its own user, 0600).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";

/** The SDK's connection to one daemon (`createHostClient`). */
export type DaemonClient = ReturnType<typeof createHostClient>;

/** No daemon at the target, or it refused the connection. */
export class PaseoUnreachable extends Error {
	override name = "PaseoUnreachable";
	constructor(
		message: string,
		/** What to do about it. */
		readonly fix: string,
	) {
		super(message);
	}
}

export type PaseoTarget = {
	/** What createHostClient connects to. */
	connection: string;
	/** The Paseo home whose local credential may apply. */
	home: string;
	/** For messages: `local (<home>)` or the host. */
	where: string;
};

/** The Paseo home: PASEO_HOME, else ~/.paseo. */
export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
	const h = env.PASEO_HOME?.trim();
	if (!h) return join(homedir(), ".paseo");
	return h.startsWith("~/") ? join(homedir(), h.slice(2)) : h;
}

function listenOf(home: string): string | null {
	try {
		const lock = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as {
			listen?: unknown;
		};
		return typeof lock.listen === "string" && lock.listen.trim()
			? lock.listen.trim()
			: null;
	} catch {
		return null;
	}
}

/** The daemon for `host` (or the local home). Throws {@link PaseoUnreachable}. */
export function resolveTarget(
	host?: string,
	env: NodeJS.ProcessEnv = process.env,
): PaseoTarget {
	const home = paseoHome(env);
	const explicit = host?.trim() || env.PASEO_HOST?.trim();
	if (explicit) return { connection: explicit, home, where: explicit };
	const listen = listenOf(home);
	if (!listen)
		throw new PaseoUnreachable(
			`no Paseo daemon runs for ${home} (no listen address in ${join(home, "paseo.pid")})`,
			"start it: paseo daemon start",
		);
	return { connection: listen, home, where: `local (${home})` };
}

/** `host:port`, `unix://...` in one form, loopback names as localhost. */
export function normalizeTarget(target: string): string {
	let t = target.trim();
	if (t.startsWith("tcp://")) t = t.slice(6).split(/[/?]/)[0] ?? t;
	if (t.startsWith("/")) return `unix://${t}`;
	if (t.startsWith("unix://") || t.startsWith("pipe://")) return t;
	if (/^\d+$/.test(t)) return `localhost:${t}`;
	return t.replace(/^(127\.0\.0\.1|\[::1\]|::1)(?=:)/, "localhost");
}

/** The home's local credential, only for the address that home's daemon listens on. */
export function localCredential(target: PaseoTarget): string | undefined {
	const listen = listenOf(target.home);
	if (!listen || normalizeTarget(listen) !== normalizeTarget(target.connection))
		return undefined;
	try {
		const token = readFileSync(
			join(target.home, "local-credential"),
			"utf8",
		).trim();
		return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
	} catch {
		return undefined;
	}
}

function passwordOf(
	connection: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	try {
		const p = parseHostTarget(connection).password;
		if (p) return p;
	} catch {}
	return env.PASEO_PASSWORD || undefined;
}

export type ConnectOptions = {
	/** Keep reconnecting (long agent runs). Default false: one-shot calls. */
	reconnect?: boolean;
	/** Default 15 s, like the CLI. */
	timeoutMs?: number;
	clientId?: string;
	env?: NodeJS.ProcessEnv;
};

/** One SDK connection to the daemon for `host` (or the local home). */
export async function connectDaemon(
	host?: string,
	o: ConnectOptions = {},
): Promise<{ client: DaemonClient; target: PaseoTarget }> {
	const env = o.env ?? process.env;
	const target = resolveTarget(host, env);
	const password = passwordOf(target.connection, env);
	let client: DaemonClient;
	try {
		client = createHostClient(target.connection, {
			clientId: o.clientId ?? "mastermind-runner",
			clientType: "cli",
			...(password
				? { password }
				: { localCredential: () => localCredential(target) }),
			connectTimeoutMs: o.timeoutMs ?? 15_000,
			reconnect: o.reconnect
				? { enabled: true, baseDelayMs: 500, maxDelayMs: 5000 }
				: { enabled: false },
		});
	} catch (error) {
		throw new PaseoUnreachable(
			`invalid Paseo host ${target.where}: ${error instanceof Error ? error.message : error}`,
			"check --paseo-host / targets paseoHost",
		);
	}
	try {
		await client.connect();
	} catch (error) {
		await client.close().catch(() => {});
		const m = error instanceof Error ? error.message : String(error);
		throw new PaseoUnreachable(
			`the Paseo daemon at ${target.where} does not answer: ${m}`,
			/password/i.test(m)
				? "set PASEO_PASSWORD (or a password in the host URI)"
				: host || env.PASEO_HOST
					? "check --paseo-host / targets paseoHost, and that its daemon runs"
					: "start it: paseo daemon start",
		);
	}
	return { client, target };
}
