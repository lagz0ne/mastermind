import { type Auth, AuthError, BUCKETS } from "./service.ts";

/**
 * HTTP side of auth:
 *
 *   POST   /api/auth/login                 {token} -> session cookie
 *   POST   /api/auth/logout
 *   GET    /api/auth/me                    -> {account, csrf}
 *   POST   /api/auth/tokens                {kind: "invite", account} | {kind: "login"} | {kind: "enrol", name}
 *   POST   /api/auth/enrol                 {token} -> service account credential (runner adapters)
 *   GET    /api/auth/service-accounts
 *   DELETE /api/auth/service-accounts/:id  revoke
 *
 * Session routes that change state need header `x-csrf-token` (from /me).
 */

export const SESSION_COOKIE = "mm_session";
export const CSRF_HEADER = "x-csrf-token";

export type AuthRoutesOptions = {
	/** Public origin of the UI, for login links (`https://host`). */
	publicUrl: string;
	/** Secret for Bun.CSRF tokens. */
	csrfSecret: string;
	/** Public NATS WebSocket URL, returned to a runner when it enrols. */
	natsUrl?: string;
	onError?: (error: unknown) => void;
};

type Req = Request & { params?: Record<string, string> };
type Handler = (req: Req) => Promise<Response>;

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
	Response.json(body, { status, headers });
const fail = (status: number, error: string) => json({ error }, status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
	if (!req.headers.get("content-type")?.startsWith("application/json"))
		return null;
	try {
		const b = await req.json();
		return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function sessionCookie(value: string, secure: boolean, maxAge: number) {
	return new Bun.Cookie(SESSION_COOKIE, value, {
		httpOnly: true,
		secure,
		sameSite: "lax",
		path: "/",
		maxAge,
	}).serialize();
}

/**
 * Routes for Bun.serve. `auth` may be a getter: until it returns an Auth
 * (NATS still connecting), every route answers 503.
 */
export function authRoutes(
	source: Auth | (() => Auth | null),
	opts: AuthRoutesOptions,
) {
	const current = typeof source === "function" ? source : () => source;
	const secure = opts.publicUrl.startsWith("https:");
	const maxAge = Math.floor(BUCKETS.sessions.ttlMs / 1000);
	const loginUrl = (token: string) => `${opts.publicUrl}/login#${token}`;

	const sessionOf = (req: Request) =>
		new Bun.CookieMap(req.headers.get("cookie") ?? "").get(SESSION_COOKIE);

	/** Wrap a handler: map AuthError to a status, hide other errors. */
	const handle =
		(fn: (req: Req, auth: Auth) => Promise<Response>): Handler =>
		async (req) => {
			const auth = current();
			if (!auth) return fail(503, "auth is starting");
			try {
				return await fn(req, auth);
			} catch (error) {
				if (error instanceof AuthError) {
					const status = { bad_request: 400, conflict: 409, not_found: 404 }[
						error.code
					];
					return fail(status, error.message);
				}
				opts.onError?.(error);
				return fail(500, "internal error");
			}
		};

	/** A handler that needs a session; `csrf` also checks the CSRF header. */
	const withAccount = (
		fn: (req: Req, account: string, auth: Auth) => Promise<Response>,
		csrf = true,
	): Handler =>
		handle(async (req, auth) => {
			const account = await auth.session(sessionOf(req));
			if (!account) return fail(401, "not logged in");
			if (csrf) {
				const t = req.headers.get(CSRF_HEADER);
				if (!t || !Bun.CSRF.verify(t, { secret: opts.csrfSecret }))
					return fail(403, "bad csrf token");
			}
			return fn(req, account, auth);
		});

	return {
		"/api/auth/login": {
			POST: handle(async (req, auth) => {
				const token = (await body(req))?.token;
				if (typeof token !== "string") return fail(400, "token required");
				const res = await auth.login(token);
				if (!res) return fail(401, "token is invalid or used");
				return json({ account: res.account }, 200, {
					"set-cookie": sessionCookie(res.sessionId, secure, maxAge),
				});
			}),
		},
		"/api/auth/logout": {
			POST: handle(async (req, auth) => {
				const s = sessionOf(req);
				if (s) await auth.logout(s);
				return json({ ok: true }, 200, {
					"set-cookie": sessionCookie("", secure, 0),
				});
			}),
		},
		"/api/auth/me": {
			GET: withAccount(
				async (_req, account) =>
					json({
						account,
						csrf: Bun.CSRF.generate(opts.csrfSecret, {
							expiresIn: 12 * 60 * 60 * 1000,
						}),
					}),
				false,
			),
		},
		"/api/auth/tokens": {
			POST: withAccount(async (req, account, auth) => {
				const b = await body(req);
				switch (b?.kind) {
					case "invite": {
						const token = await auth.invite(account, String(b.account ?? ""));
						return json({ token, url: loginUrl(token) }, 201);
					}
					case "login": {
						const token = await auth.loginToken(account);
						return json({ token, url: loginUrl(token) }, 201);
					}
					case "enrol": {
						const token = await auth.enrolToken(account, String(b.name ?? ""));
						return json({ token }, 201);
					}
					default:
						return fail(400, "kind must be invite, login or enrol");
				}
			}),
		},
		"/api/auth/enrol": {
			POST: handle(async (req, auth) => {
				const token = (await body(req))?.token;
				if (typeof token !== "string") return fail(400, "token required");
				const res = await auth.enrol(token);
				if (!res) return fail(401, "token is invalid or used");
				return json(
					{
						account: res.serviceAccount.account,
						serviceAccount: res.serviceAccount,
						credential: res.credential,
						natsUrl: opts.natsUrl ?? null,
						inboxPrefix: `_INBOX.${res.serviceAccount.account}`,
					},
					201,
				);
			}),
		},
		"/api/auth/service-accounts": {
			GET: withAccount(
				async (_req, account, auth) =>
					json({ serviceAccounts: await auth.serviceAccounts(account) }),
				false,
			),
		},
		"/api/auth/service-accounts/:id": {
			DELETE: withAccount(async (req, account, auth) => {
				const id = req.params?.id ?? "";
				return (await auth.revoke(account, id))
					? json({ ok: true })
					: fail(404, "no such service account");
			}),
		},
	};
}
