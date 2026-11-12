/**
 * People: who has an account, and which runners they brought.
 *
 *   GET /api/people/setup    public: auth state, and whether the first login is pending
 *   GET /api/people/me       the session's account
 *   GET /api/accounts        every account, who invited whom
 *   GET /api/runners         runners joined with service accounts
 *   GET /api/people/events   SSE: `runners` with the whole list on every change
 *   GET /runner.js           public: the runner adapter for `bun`
 *
 * Invites, enrol tokens and revoke stay in /api/auth (tokens, service-accounts).
 */
import type {
	AccountsReply,
	Me,
	PeopleSetup,
	RunnersReply,
	RunnerView,
	ServiceAccountRef,
} from "@mastermind/core";
import type { Server } from "bun";
import type { Auth, ServiceAccountView } from "../auth/service.ts";
import type { RequireAccount } from "../auth/session.ts";
import type { RunnerEntry, RunnerRegistry } from "./registry.ts";
import type { RunnerScript } from "./runner-script.ts";

export type PeopleOptions = {
	requireAccount: RequireAccount;
	/** The auth service once it runs; null while starting or when auth is off. */
	auth: () => Auth | null;
	/** `on` when auth is configured; `off` with AUTH_DISABLED=1; else `unconfigured`. */
	mode: "on" | "off" | "unconfigured";
	registry: RunnerRegistry;
	runnerScript: RunnerScript;
	/** The server's commit, sent with the runner list so the UI marks other versions. */
	version?: string;
	/** The stream re-checks online state this often. Default 5 s. */
	tickMs?: number;
	/** SSE comment so proxies keep the stream open. Default 8 s. */
	keepAliveMs?: number;
	onError?: (error: unknown) => void;
};

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

const ref = (sa: ServiceAccountView): ServiceAccountRef => ({
	id: sa.id,
	name: sa.name,
	createdAt: sa.createdAt,
	lastSeenAt: sa.lastSeenAt,
	state: sa.state,
});

/** Registry joined with service accounts. Without `sas` (auth off): registry only. */
export function joinRunners(
	entries: RunnerEntry[],
	sas: ServiceAccountView[] | null,
): RunnerView[] {
	const byId = new Map(sas?.map((sa) => [sa.id, sa]));
	const used = new Set<string>();
	const rows: RunnerView[] = [];
	for (const e of entries) {
		const sa = e.serviceAccount ? byId.get(e.serviceAccount) : undefined;
		// With auth on, a runner whose service account is gone was revoked.
		if (sas && e.serviceAccount && !sa) continue;
		if (sa) used.add(sa.id);
		rows.push({
			account: e.account,
			serviceAccount: sa ? ref(sa) : null,
			runner: e.runner,
			online: e.online,
			lastSeenAt: e.lastSeenAt,
			queues: e.queues,
			capabilities: e.capabilities,
			providers: e.providers,
			capacity: e.capacity,
			running: e.running,
			version: e.version,
			readiness: e.diagnostics?.readiness ?? null,
		});
	}
	for (const sa of sas ?? []) {
		if (used.has(sa.id)) continue;
		rows.push({
			account: sa.account,
			serviceAccount: ref(sa),
			runner: null,
			online: false,
			lastSeenAt: null,
			queues: [],
			capabilities: [],
			providers: [],
			capacity: null,
			running: [],
			version: null,
		});
	}
	return rows.sort(
		(a, b) =>
			a.account.localeCompare(b.account) ||
			(a.runner ?? "~").localeCompare(b.runner ?? "~") ||
			(a.serviceAccount?.name ?? "").localeCompare(
				b.serviceAccount?.name ?? "",
			),
	);
}

const encoder = new TextEncoder();

export function peopleRoutes(opts: PeopleOptions) {
	const { registry, tickMs = 5_000, keepAliveMs = 8_000 } = opts;

	/** Run `fn` for a logged-in request; guard failures pass through. */
	const session =
		(fn: (req: Request, account: string) => Promise<Response>) =>
		async (req: Request): Promise<Response> => {
			const who = await opts.requireAccount(req);
			if (who instanceof Response) return who;
			try {
				return await fn(req, who);
			} catch (error) {
				opts.onError?.(error);
				return fail(500, "internal error");
			}
		};

	/** Null when auth is off; throws 503-worthy null auth when starting. */
	async function runners(): Promise<RunnerView[]> {
		const auth = opts.auth();
		if (opts.mode === "on" && !auth) throw new Starting();
		const sas = auth ? await auth.serviceAccounts() : null;
		return joinRunners(registry.list(), sas);
	}

	async function events(
		req: Request,
		server?: Server<unknown>,
	): Promise<Response> {
		const who = await opts.requireAccount(req);
		if (who instanceof Response) return who;
		server?.timeout(req, 0);
		let cleanup = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				let last = "";
				let busy = false;
				let again = false;
				const push = async () => {
					if (closed) return;
					if (busy) {
						again = true;
						return;
					}
					busy = true;
					try {
						do {
							again = false;
							const reply: RunnersReply = {
								runners: await runners(),
								serverVersion: opts.version,
							};
							const body = JSON.stringify(reply);
							if (!closed && body !== last) {
								last = body;
								controller.enqueue(
									encoder.encode(`event: runners\ndata: ${body}\n\n`),
								);
							}
						} while (again && !closed);
					} catch (error) {
						if (!(error instanceof Starting)) opts.onError?.(error);
					} finally {
						busy = false;
					}
				};
				const unsubscribe = registry.subscribe(() => void push());
				const tick = setInterval(() => void push(), tickMs);
				const keepAlive = setInterval(() => {
					if (!closed) controller.enqueue(encoder.encode(": ka\n\n"));
				}, keepAliveMs);
				cleanup = () => {
					if (closed) return;
					closed = true;
					unsubscribe();
					clearInterval(tick);
					clearInterval(keepAlive);
				};
				req.signal.addEventListener("abort", () => {
					cleanup();
					try {
						controller.close();
					} catch {}
				});
				controller.enqueue(encoder.encode("retry: 2000\n\n"));
				void push();
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	}

	return {
		"/api/people/setup": {
			GET: async (): Promise<Response> => {
				const auth = opts.auth();
				const mode = opts.mode === "on" && !auth ? "starting" : opts.mode;
				let firstLogin = false;
				try {
					firstLogin = auth ? (await auth.accounts()).length === 0 : false;
				} catch (error) {
					opts.onError?.(error);
				}
				const body: PeopleSetup = { auth: mode, firstLogin };
				return Response.json(body);
			},
		},
		"/api/people/me": {
			GET: session(async (_req, account) => {
				const body: Me = {
					account,
					auth: opts.mode === "off" ? "off" : "on",
				};
				return Response.json(body);
			}),
		},
		"/api/accounts": {
			GET: session(async (_req, account) => {
				const auth = opts.auth();
				if (opts.mode === "on" && !auth) return fail(503, "auth is starting");
				const body: AccountsReply = {
					accounts: auth
						? await auth.accounts()
						: [{ id: account, createdAt: "", invitedBy: null }],
				};
				return Response.json(body);
			}),
		},
		"/api/runners": {
			GET: session(async () => {
				try {
					const body: RunnersReply = {
						runners: await runners(),
						serverVersion: opts.version,
					};
					return Response.json(body);
				} catch (error) {
					if (error instanceof Starting) return fail(503, "auth is starting");
					throw error;
				}
			}),
		},
		"/api/people/events": { GET: events },
		"/runner.js": {
			GET: async (): Promise<Response> => {
				try {
					return await opts.runnerScript();
				} catch (error) {
					opts.onError?.(error);
					return fail(500, "runner bundle failed");
				}
			},
		},
	};
}

class Starting extends Error {}
