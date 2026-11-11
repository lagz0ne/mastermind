/**
 * Read-only operator routes: /api/debug/*. Auth: `Authorization: Bearer
 * <MASTERMIND_OPERATOR_KEY>` (constant-time compare of hashes). Off (404)
 * when the key is unset. Rate limited per address. One audit line per call,
 * without secrets.
 */
import { clientIp, RateLimit } from "../auth/rate-limit.ts";
import { sameSecret, sha256 } from "../auth/secrets.ts";
import { type DebugSources, debugState } from "./state.ts";

export type DebugRoutesOptions = {
	operatorKey?: string;
	sources: DebugSources;
	audit?: (line: string) => void;
	onError?: (error: unknown) => void;
	/** Requests per minute per address. Default 60. */
	perMinute?: number;
};

type Handler = (req: Request) => Promise<Response>;

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

export function debugRoutes(opts: DebugRoutesOptions) {
	const keyHash = opts.operatorKey ? sha256(opts.operatorKey) : null;
	const limit = new RateLimit(opts.perMinute ?? 60, 60_000);
	const audit = opts.audit ?? console.log;

	const operator =
		(name: string, fn: (req: Request) => Promise<Response>): Handler =>
		async (req) => {
			const ip = clientIp(req);
			const done = (res: Response) => {
				audit(`debug: ${name} from ${ip} -> ${res.status}`);
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
	};
}
