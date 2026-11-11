/**
 * Read-only operator routes: /api/debug/*. Auth: `Authorization: Bearer
 * <MASTERMIND_OPERATOR_KEY>` (constant-time compare of hashes). Off (404)
 * when the key is unset. Rate limited per address. One audit line per call,
 * without secrets.
 */
import { BusError } from "@mastermind/bus";
import { clientIp, RateLimit } from "../auth/rate-limit.ts";
import { sameSecret, sha256 } from "../auth/secrets.ts";
import { type EventSources, eventsPage, eventsStream } from "./events.ts";
import { decide, type ItemSources } from "./item.ts";
import { type DebugSources, debugState } from "./state.ts";

export type DebugRoutesOptions = {
	operatorKey?: string;
	sources: DebugSources;
	/** The work store, for GET /api/debug/items/:id; null without one. */
	items?: ItemSources | null;
	/** Work events, runner changes, error lines, for GET /api/debug/events. */
	events?: EventSources;
	/**
	 * Ask a runner to run its doctor (NATS request on
	 * mm.u.<account>.r.<runner>.doctor); resolves with its report. Null: NATS is off.
	 */
	doctor?:
		| ((account: string, runner: string, deep: boolean) => Promise<unknown>)
		| null;
	audit?: (line: string) => void;
	onError?: (error: unknown) => void;
	/** Requests per minute per address. Default 60. */
	perMinute?: number;
};

type Req = Request & { params?: Record<string, string> };
/** Bun's server, for `timeout(req, s)` on long requests. */
type Server = { timeout?(req: Request, seconds: number): void };
type Handler = (req: Req, server?: Server) => Promise<Response>;

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

export function debugRoutes(opts: DebugRoutesOptions) {
	const keyHash = opts.operatorKey ? sha256(opts.operatorKey) : null;
	const limit = new RateLimit(opts.perMinute ?? 60, 60_000);
	const audit = opts.audit ?? console.log;

	const operator =
		(
			name: string,
			fn: (req: Req, server?: Server) => Promise<Response>,
		): Handler =>
		async (req, server) => {
			const ip = clientIp(req);
			const done = (res: Response) => {
				const p = req.params ?? {};
				const target = p.id ?? (p.runner ? `${p.account}/${p.runner}` : "");
				const id = target ? ` ${target.slice(0, 64)}` : "";
				audit(`debug: ${name}${id} from ${ip} -> ${res.status}`);
				return res;
			};
			if (!keyHash) return done(fail(404, "debug is off: no operator key"));
			if (!limit.take(ip)) return done(fail(429, "too many requests"));
			const bearer = /^Bearer\s+(\S+)$/i.exec(
				req.headers.get("authorization") ?? "",
			)?.[1];
			if (!bearer || !sameSecret(keyHash, sha256(bearer)))
				return done(fail(401, "operator key required"));
			try {
				return done(await fn(req, server));
			} catch (error) {
				opts.onError?.(error);
				return done(fail(500, "internal error"));
			}
		};

	return {
		"/api/debug/state": {
			GET: operator("state", async () =>
				Response.json(await debugState(opts.sources), {
					headers: { "cache-control": "no-store" },
				}),
			),
		},
		"/api/debug/events": {
			GET: operator("events", async (req) => {
				const q = new URL(req.url).searchParams;
				const since = Math.max(0, Number(q.get("since") ?? 0) || 0);
				const src = opts.events ?? {};
				if (q.get("follow") === "1")
					return eventsStream(src, since, req.signal);
				return Response.json(await eventsPage(src, since), {
					headers: { "cache-control": "no-store" },
				});
			}),
		},
		"/api/debug/runners/:account/:runner/doctor": {
			POST: operator("doctor", async (req, server) => {
				if (!opts.doctor) return fail(503, "NATS is off or starting");
				// Bun closes a request idle for 10 s; a deep doctor waits up to 3 min.
				server?.timeout?.(req, 200);
				const account = req.params?.account ?? "";
				const runner = req.params?.runner ?? "";
				const deep = new URL(req.url).searchParams.get("deep") === "1";
				try {
					return Response.json(await opts.doctor(account, runner, deep), {
						headers: { "cache-control": "no-store" },
					});
				} catch (error) {
					if (error instanceof BusError) {
						if (error.code === "unavailable")
							return fail(
								404,
								`runner ${account}/${runner} does not answer: not running, or its version has no remote doctor`,
							);
						if (error.code === "timeout")
							return fail(
								504,
								`runner ${account}/${runner} did not answer in time`,
							);
						if (error.code === "bad_request") return fail(400, error.message);
					}
					throw error;
				}
			}),
		},
		"/api/debug/items/:id": {
			GET: operator("item", async (req) => {
				const store = opts.items;
				if (!store) return fail(503, "the work store is off");
				const id = req.params?.id ?? "";
				const src = opts.sources;
				let bead: Awaited<ReturnType<ItemSources["get"]>>;
				try {
					bead = await store.get(id);
				} catch (error) {
					if ((error as { name?: string })?.name === "NotFound")
						return fail(404, `no item ${id}`);
					throw error;
				}
				const [timeline, comments, routing] = await Promise.all([
					store.journalOf(id),
					store.comments(id),
					src
						.routing?.()
						?.read()
						.catch(() => null) ?? null,
				]);
				const now = (src.now ?? (() => new Date()))();
				return Response.json(
					{
						item: bead,
						routing: decide(
							bead,
							routing as Parameters<typeof decide>[1],
							src.runners?.() ?? [],
							now,
						),
						timeline,
						comments,
					},
					{ headers: { "cache-control": "no-store" } },
				);
			}),
		},
	};
}
