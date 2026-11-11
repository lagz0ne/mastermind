/**
 * Read-only operator routes: /api/debug/*. Auth: `Authorization: Bearer
 * <MASTERMIND_OPERATOR_KEY>` (constant-time compare of hashes). Off (404)
 * when the key is unset. Rate limited per address. One audit line per call,
 * without secrets.
 */
import { clientIp, RateLimit } from "../auth/rate-limit.ts";
import { sameSecret, sha256 } from "../auth/secrets.ts";
import { decide, type ItemSources } from "./item.ts";
import { type DebugSources, debugState } from "./state.ts";

export type DebugRoutesOptions = {
	operatorKey?: string;
	sources: DebugSources;
	/** The work store, for GET /api/debug/items/:id; null without one. */
	items?: ItemSources | null;
	audit?: (line: string) => void;
	onError?: (error: unknown) => void;
	/** Requests per minute per address. Default 60. */
	perMinute?: number;
};

type Req = Request & { params?: Record<string, string> };
type Handler = (req: Req) => Promise<Response>;

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

export function debugRoutes(opts: DebugRoutesOptions) {
	const keyHash = opts.operatorKey ? sha256(opts.operatorKey) : null;
	const limit = new RateLimit(opts.perMinute ?? 60, 60_000);
	const audit = opts.audit ?? console.log;

	const operator =
		(name: string, fn: (req: Req) => Promise<Response>): Handler =>
		async (req) => {
			const ip = clientIp(req);
			const done = (res: Response) => {
				const id = req.params?.id ? ` ${req.params.id.slice(0, 64)}` : "";
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
				return done(await fn(req));
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
