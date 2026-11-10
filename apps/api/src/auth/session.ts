import { CSRF_HEADER, SESSION_COOKIE } from "./routes.ts";
import type { Auth } from "./service.ts";

/**
 * The session check for every /api route outside /api/auth:
 *
 *   const who = await requireAccount(req);
 *   if (who instanceof Response) return who;   // 401, 403 or 503
 *   // who is the account id
 *
 * Requests that change state (any method but GET and HEAD) also need the
 * header `x-csrf-token` from GET /api/auth/me.
 */
export type RequireAccount = (req: Request) => Promise<string | Response>;

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

const SAFE = new Set(["GET", "HEAD"]);

/** The account of the session cookie. `source` may be a getter (503 until it returns an Auth). */
export function accountGuard(
	source: Auth | (() => Auth | null),
	csrfSecret: string,
): RequireAccount {
	const current = typeof source === "function" ? source : () => source;
	return async (req) => {
		const auth = current();
		if (!auth) return fail(503, "auth is starting");
		const cookie = new Bun.CookieMap(req.headers.get("cookie") ?? "").get(
			SESSION_COOKIE,
		);
		const account = await auth.session(cookie);
		if (!account) return fail(401, "not logged in");
		if (!SAFE.has(req.method)) {
			const t = req.headers.get(CSRF_HEADER);
			if (!t || !Bun.CSRF.verify(t, { secret: csrfSecret }))
				return fail(403, "bad csrf token");
		}
		return account;
	};
}

/** Account of every request when auth is off on purpose (local dev only). */
export const LOCAL_ACCOUNT = "local";

/**
 * The guard for the server:
 * - auth configured: the session guard;
 * - auth not configured and `AUTH_DISABLED=1`: every request is account `local`;
 * - else: 503, so that a deploy without auth never serves the API open.
 */
export function requireAccountFromEnv(
	auth: { requireAccount: RequireAccount } | null,
	env: Record<string, string | undefined>,
): RequireAccount {
	if (auth) return auth.requireAccount;
	if (env.AUTH_DISABLED === "1") return async () => LOCAL_ACCOUNT;
	return async () =>
		fail(
			503,
			"auth unconfigured: set NATS_WS_URL, NATS_ISSUER_SEED and NATS_AUTH_PASSWORD (or AUTH_DISABLED=1 for local dev)",
		);
}
