import { formatCode, normalizeCode } from "./code.ts";
import { clientIp, RateLimit } from "./rate-limit.ts";
import { sameSecret, sha256 } from "./secrets.ts";
import {
	type Approver,
	type Auth,
	AuthError,
	BUCKETS,
	LOGIN_CODE_TTL_MS,
} from "./service.ts";

/**
 * HTTP side of auth:
 *
 *   POST   /api/auth/login/start           -> {code, expiresAt} + pending-login cookie
 *   POST   /api/auth/login/approve         {code, account}; operator (Bearer key) or a session
 *   POST   /api/auth/login/deny            {code}; operator (Bearer key) or a session
 *   GET    /api/auth/login/poll            pending-login cookie -> {status: pending|expired|denied|approved};
 *                                          session cookie once approved
 *   POST   /api/auth/logout
 *   GET    /api/auth/me                    -> {account, displayName, csrf}
 *   POST   /api/auth/tokens                {kind: "enrol", name} -> single-use enrol token
 *   POST   /api/auth/enrol                 {token} -> service account credential (runner adapters)
 *   GET    /api/auth/credential            Bearer <credential> -> 200 {account, serviceAccount} or 401
 *                                          (a runner tells a revocation from a NATS restart)
 *   GET    /api/auth/service-accounts
 *   DELETE /api/auth/service-accounts/:id  revoke
 *
 * Session routes that change state need header `x-csrf-token` (from /me).
 */

export const SESSION_COOKIE = "mm_session";
export const CSRF_HEADER = "x-csrf-token";
/** The browser's half of a pending login (`<code>.<secret>`). */
export const LOGIN_COOKIE = "mm_login";

export type AuthRoutesOptions = {
	/** Public origin of the UI (`https://host`); https means secure cookies. */
	publicUrl: string;
	/** Secret for Bun.CSRF tokens. */
	csrfSecret: string;
	/** Public NATS WebSocket URL, returned to a runner when it enrols. */
	natsUrl?: string;
	/** Bearer key of the operator for /api/auth/login/approve and deny. Unset: no operator. */
	operatorKey?: string;
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

function loginCookie(value: string, secure: boolean, maxAge: number) {
	return new Bun.Cookie(LOGIN_COOKIE, value, {
		httpOnly: true,
		secure,
		sameSite: "lax",
		path: "/api/auth/login",
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

	const cookieOf = (req: Request, name: string) =>
		new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);
	const sessionOf = (req: Request) => cookieOf(req, SESSION_COOKIE);
	const operatorHash = opts.operatorKey ? sha256(opts.operatorKey) : null;
	// Per replica. Start: per address. Approve: per address and per approver.
	const startLimit = new RateLimit(20, 60_000);
	const approveLimit = new RateLimit(20, 60_000);
	const credentialLimit = new RateLimit(60, 60_000);
	const limited = () => fail(429, "too many requests; wait a minute");

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
					const status = {
						bad_request: 400,
						conflict: 409,
						forbidden: 403,
						not_found: 404,
					}[error.code];
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

	/**
	 * Approve or deny as the operator (Bearer key) or as the session's account
	 * (with CSRF). Both share one rate limit: each guesses a code.
	 */
	const asApprover = (
		fn: (
			b: Record<string, unknown> | null,
			approver: Approver,
			auth: Auth,
		) => Promise<Response>,
	): Handler =>
		handle(async (req, auth) => {
			if (!approveLimit.take(`ip:${clientIp(req)}`)) return limited();
			let approver: Approver;
			const bearer = /^Bearer\s+(\S+)$/i.exec(
				req.headers.get("authorization") ?? "",
			)?.[1];
			if (bearer) {
				if (!operatorHash || !sameSecret(operatorHash, sha256(bearer)))
					return fail(401, "bad operator key");
				approver = { kind: "operator" };
			} else {
				const account = await auth.session(sessionOf(req));
				if (!account) return fail(401, "not logged in");
				const t = req.headers.get(CSRF_HEADER);
				if (!t || !Bun.CSRF.verify(t, { secret: opts.csrfSecret }))
					return fail(403, "bad csrf token");
				approver = { kind: "account", account };
			}
			const who = approver.kind === "operator" ? "operator" : approver.account;
			if (!approveLimit.take(`by:${who}`)) return limited();
			return fn(await body(req), approver, auth);
		});
	const approve = asApprover(async (b, approver, auth) => {
		if (typeof b?.code !== "string" || typeof b.account !== "string")
			return fail(400, "code and account required");
		return json(await auth.approveLogin(b.code, b.account, approver));
	});
	const deny = asApprover(async (b, approver, auth) => {
		if (typeof b?.code !== "string") return fail(400, "code required");
		await auth.denyLogin(b.code, approver);
		return json({ ok: true });
	});

	return {
		"/api/auth/login/start": {
			POST: handle(async (req, auth) => {
				if (!startLimit.take(clientIp(req))) return limited();
				const s = await auth.startLogin(req.headers.get("user-agent") ?? "");
				return json({ code: formatCode(s.code), expiresAt: s.expiresAt }, 201, {
					"set-cookie": loginCookie(
						s.cookie,
						secure,
						Math.floor(LOGIN_CODE_TTL_MS / 1000),
					),
				});
			}),
		},
		"/api/auth/login/approve": { POST: approve },
		"/api/auth/login/deny": { POST: deny },
		"/api/auth/login/poll": {
			GET: handle(async (req, auth) => {
				const cookie = cookieOf(req, LOGIN_COOKIE);
				const r = await auth.pollLogin(cookie);
				// Pending: the cookie is valid, so its code part is the code. The
				// page shows it again after a reload instead of starting a new one.
				if (r.status === "pending") {
					const code = normalizeCode(cookie?.split(".", 1)[0] ?? "");
					return json(
						{ ...r, ...(code ? { code: formatCode(code) } : {}) },
						200,
						{ "cache-control": "no-store" },
					);
				}
				const headers = new Headers({
					"set-cookie": loginCookie("", secure, 0),
					"cache-control": "no-store",
				});
				if (r.status === "expired" || r.status === "denied")
					return Response.json({ status: r.status }, { headers });
				headers.append(
					"set-cookie",
					sessionCookie(r.sessionId, secure, maxAge),
				);
				return Response.json(
					{ status: "approved", account: r.account },
					{ headers },
				);
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
				async (_req, account, auth) =>
					json({
						account,
						displayName: await auth.displayName(account),
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
					case "enrol": {
						const token = await auth.enrolToken(account, String(b.name ?? ""));
						return json({ token }, 201);
					}
					default:
						return fail(400, "kind must be enrol");
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
		// A runner whose NATS login is refused asks here whether its credential
		// is still valid. Only 401 means revoked; the runner retries on anything else.
		"/api/auth/credential": {
			GET: handle(async (req, auth) => {
				if (!credentialLimit.take(clientIp(req))) return limited();
				const credential = /^Bearer\s+(\S+)$/i.exec(
					req.headers.get("authorization") ?? "",
				)?.[1];
				const sa = credential ? await auth.authorize(credential) : null;
				if (!sa)
					return fail(
						401,
						"credential is invalid, revoked, or disabled (not seen for 14 days)",
					);
				return json(
					{
						account: sa.account,
						serviceAccount: { id: sa.id, name: sa.name },
					},
					200,
					{ "cache-control": "no-store" },
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
