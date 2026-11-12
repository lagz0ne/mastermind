import { describe, expect, test } from "bun:test";
import { MemoryKv } from "./memory-kv.ts";
import {
	authRoutes,
	CSRF_HEADER,
	LOGIN_COOKIE,
	SESSION_COOKIE,
} from "./routes.ts";
import { Auth } from "./service.ts";
import { loginAs } from "./test-login.ts";

const URL_BASE = "https://mm.example";

function setup() {
	const auth = new Auth({
		accounts: new MemoryKv(),
		serviceAccounts: new MemoryKv(),
		tokens: new MemoryKv(),
		sessions: new MemoryKv(),
	});
	const routes = authRoutes(auth, {
		publicUrl: URL_BASE,
		csrfSecret: "test-secret",
		natsUrl: "wss://mm.example/nats",
	});
	return { auth, routes };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
	new Request(`${URL_BASE}/x`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

async function login() {
	const s = setup();
	const sessionId = await loginAs(s.auth, "admin");
	const cookie = `${SESSION_COOKIE}=${sessionId}`;
	const me = await s.routes["/api/auth/me"].GET(
		new Request(`${URL_BASE}/x`, { headers: { cookie } }),
	);
	const { csrf } = (await me.json()) as { csrf: string };
	return { ...s, cookie, csrf };
}

describe("auth routes", () => {
	test("me needs a session", async () => {
		const { routes } = setup();
		const res = await routes["/api/auth/me"].GET(new Request(`${URL_BASE}/x`));
		expect(res.status).toBe(401);
	});

	test("me shows the display name in the case it was typed", async () => {
		const s = setup();
		const sessionId = await loginAs(s.auth, "Lagz0ne");
		const me = await s.routes["/api/auth/me"].GET(
			new Request(`${URL_BASE}/x`, {
				headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
			}),
		);
		expect(await me.json()).toMatchObject({
			account: "lagz0ne",
			displayName: "Lagz0ne",
		});
	});

	test("approve: a bad name gets 400 with the rule", async () => {
		const { routes, cookie, csrf } = await login();
		const res = await routes["/api/auth/login/approve"].POST(
			post(
				{ code: "ABCD-EFGH", account: "no spaces" },
				{ cookie, [CSRF_HEADER]: csrf },
			),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "account id: a-z, 0-9 and -, at most 32",
		});
	});

	test("minting tokens needs the CSRF header; only enrol tokens are left", async () => {
		const { routes, cookie, csrf } = await login();
		const tokens = routes["/api/auth/tokens"].POST;
		const enrol = { kind: "enrol", name: "laptop" };
		expect((await tokens(post(enrol, { cookie }))).status).toBe(403);
		expect(
			(await tokens(post(enrol, { cookie, [CSRF_HEADER]: "bad" }))).status,
		).toBe(403);
		const h = { cookie, [CSRF_HEADER]: csrf };
		expect((await tokens(post(enrol, h))).status).toBe(201);
		for (const kind of ["login", "invite", "x"])
			expect((await tokens(post({ kind, account: "bob" }, h))).status).toBe(
				400,
			);
	});

	test("enrol, list, revoke a service account", async () => {
		const { routes, cookie, csrf } = await login();
		const h = { cookie, [CSRF_HEADER]: csrf };
		const minted = await routes["/api/auth/tokens"].POST(
			post({ kind: "enrol", name: "laptop" }, h),
		);
		const { token } = (await minted.json()) as { token: string };

		const enrol = routes["/api/auth/enrol"].POST;
		const res = await enrol(post({ token }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			account: string;
			credential: string;
			natsUrl: string;
			inboxPrefix: string;
			serviceAccount: { id: string };
		};
		expect(body).toMatchObject({
			account: "admin",
			natsUrl: "wss://mm.example/nats",
			inboxPrefix: "_INBOX.admin",
		});
		expect(body.credential).toStartWith("mms_admin_");
		expect((await enrol(post({ token }))).status).toBe(401);

		const list = await routes["/api/auth/service-accounts"].GET(
			new Request(`${URL_BASE}/x`, { headers: { cookie } }),
		);
		const { serviceAccounts } = (await list.json()) as {
			serviceAccounts: { id: string; secretHash?: string }[];
		};
		expect(serviceAccounts.map((s) => s.id)).toEqual([body.serviceAccount.id]);
		expect(serviceAccounts[0]?.secretHash).toBeUndefined();

		const check = (authorization?: string) =>
			routes["/api/auth/credential"].GET(
				new Request(`${URL_BASE}/x`, {
					headers: authorization ? { authorization } : {},
				}),
			);
		const valid = await check(`Bearer ${body.credential}`);
		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({
			account: "admin",
			serviceAccount: { id: body.serviceAccount.id, name: "laptop" },
		});
		expect((await check()).status).toBe(401);
		expect((await check(`Bearer ${body.credential}x`)).status).toBe(401);

		const del = routes["/api/auth/service-accounts/:id"].DELETE;
		const req = (id: string, headers: Record<string, string>) =>
			Object.assign(
				new Request(`${URL_BASE}/x`, { method: "DELETE", headers }),
				{
					params: { id },
				},
			);
		expect((await del(req(body.serviceAccount.id, { cookie }))).status).toBe(
			403,
		);
		expect((await del(req(body.serviceAccount.id, h))).status).toBe(200);
		expect((await del(req(body.serviceAccount.id, h))).status).toBe(404);
		expect((await check(`Bearer ${body.credential}`)).status).toBe(401);
	});

	test("logout clears the cookie and the session", async () => {
		const { routes, cookie } = await login();
		const res = await routes["/api/auth/logout"].POST(post({}, { cookie }));
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
		const me = await routes["/api/auth/me"].GET(
			new Request(`${URL_BASE}/x`, { headers: { cookie } }),
		);
		expect(me.status).toBe(401);
	});
});

test("routes answer 503 until auth is ready", async () => {
	const routes = authRoutes(() => null, {
		publicUrl: URL_BASE,
		csrfSecret: "s",
	});
	const res = await routes["/api/auth/login/start"].POST(post({}));
	expect(res.status).toBe(503);
});

describe("login by code (routes)", () => {
	const OPERATOR_KEY = "op-key-for-tests";
	function withOperator(operatorKey?: string) {
		const auth = new Auth({
			accounts: new MemoryKv(),
			serviceAccounts: new MemoryKv(),
			tokens: new MemoryKv(),
			sessions: new MemoryKv(),
		});
		const routes = authRoutes(auth, {
			publicUrl: URL_BASE,
			csrfSecret: "test-secret",
			operatorKey,
		});
		return { auth, routes };
	}
	const cookieOf = (res: Response, name: string) =>
		res.headers
			.getSetCookie()
			.find((c) => c.startsWith(`${name}=`))
			?.split(";")[0] ?? "";
	const poll = (
		routes: ReturnType<typeof withOperator>["routes"],
		cookie: string,
	) =>
		routes["/api/auth/login/poll"].GET(
			new Request(`${URL_BASE}/x`, { headers: { cookie } }),
		);

	test("start, operator approve, poll: session cookie once", async () => {
		const { routes } = withOperator(OPERATOR_KEY);
		const start = await routes["/api/auth/login/start"].POST(
			post({}, { "user-agent": "Firefox" }),
		);
		expect(start.status).toBe(201);
		const { code } = (await start.json()) as { code: string };
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		const set = start.headers.get("set-cookie") ?? "";
		expect(set).toStartWith(`${LOGIN_COOKIE}=`);
		expect(set).toContain("HttpOnly");
		expect(set).toContain("Secure");
		const pending = cookieOf(start, LOGIN_COOKIE);
		// A reload resumes the pending login: the poll gives the same code.
		expect(await (await poll(routes, pending)).json()).toMatchObject({
			status: "pending",
			code,
			expiresAt: expect.any(String),
		});

		const approve = await routes["/api/auth/login/approve"].POST(
			post(
				{ code, account: "duke" },
				{ authorization: `Bearer ${OPERATOR_KEY}` },
			),
		);
		expect(approve.status).toBe(200);
		expect(await approve.json()).toMatchObject({
			account: "duke",
			created: true,
			userAgent: "Firefox",
		});

		const done = await poll(routes, pending);
		expect(await done.json()).toEqual({ status: "approved", account: "duke" });
		expect(cookieOf(done, SESSION_COOKIE)).not.toBe(`${SESSION_COOKIE}=`);
		expect(cookieOf(done, LOGIN_COOKIE)).toBe(`${LOGIN_COOKIE}=`);
		expect(await (await poll(routes, pending)).json()).toEqual({
			status: "expired",
		});
	});

	test("a wrong operator key, or none configured, is refused", async () => {
		for (const key of [OPERATOR_KEY, undefined]) {
			const { routes } = withOperator(key);
			const start = await routes["/api/auth/login/start"].POST(post({}));
			const { code } = (await start.json()) as { code: string };
			const res = await routes["/api/auth/login/approve"].POST(
				post({ code, account: "duke" }, { authorization: "Bearer nope" }),
			);
			expect(res.status).toBe(401);
		}
	});

	test("an account approves with its session and CSRF token", async () => {
		const { routes, cookie, csrf } = await login();
		const start = await routes["/api/auth/login/start"].POST(post({}));
		const { code } = (await start.json()) as { code: string };
		const noCsrf = await routes["/api/auth/login/approve"].POST(
			post({ code, account: "bob" }, { cookie }),
		);
		expect(noCsrf.status).toBe(403);
		const ok = await routes["/api/auth/login/approve"].POST(
			post({ code, account: "bob" }, { cookie, [CSRF_HEADER]: csrf }),
		);
		expect(await ok.json()).toMatchObject({ account: "bob", created: true });
		const done = await poll(routes, cookieOf(start, LOGIN_COOKIE));
		expect(await done.json()).toEqual({ status: "approved", account: "bob" });
	});

	test("deny: the operator or an account (with CSRF) ends a login; the poll says denied", async () => {
		const { routes } = withOperator(OPERATOR_KEY);
		const start = await routes["/api/auth/login/start"].POST(post({}));
		const { code } = (await start.json()) as { code: string };
		const pending = cookieOf(start, LOGIN_COOKIE);
		const deny = routes["/api/auth/login/deny"].POST;
		expect(
			(await deny(post({ code }, { authorization: "Bearer nope" }))).status,
		).toBe(401);
		expect(
			(await deny(post({}, { authorization: `Bearer ${OPERATOR_KEY}` })))
				.status,
		).toBe(400);
		const ok = await deny(
			post({ code }, { authorization: `Bearer ${OPERATOR_KEY}` }),
		);
		expect(ok.status).toBe(200);
		const r = await poll(routes, pending);
		expect(await r.json()).toEqual({ status: "denied" });
		expect(cookieOf(r, LOGIN_COOKIE)).toBe(`${LOGIN_COOKIE}=`);
		expect(cookieOf(r, SESSION_COOKIE)).toBe("");
		// Used up: a second deny or an approve finds no code.
		expect(
			(await deny(post({ code }, { authorization: `Bearer ${OPERATOR_KEY}` })))
				.status,
		).toBe(404);
	});

	test("deny as an account needs the CSRF token", async () => {
		const { routes, cookie, csrf } = await login();
		const start = await routes["/api/auth/login/start"].POST(post({}));
		const { code } = (await start.json()) as { code: string };
		const deny = routes["/api/auth/login/deny"].POST;
		expect((await deny(post({ code }, { cookie }))).status).toBe(403);
		expect(
			(await deny(post({ code }, { cookie, [CSRF_HEADER]: csrf }))).status,
		).toBe(200);
		const r = await poll(routes, cookieOf(start, LOGIN_COOKIE));
		expect(await r.json()).toEqual({ status: "denied" });
	});

	test("a wrong code says nothing about other codes; approve is rate limited", async () => {
		const { routes } = withOperator(OPERATOR_KEY);
		const statuses: number[] = [];
		for (let i = 0; i < 25; i++) {
			const res = await routes["/api/auth/login/approve"].POST(
				post(
					{ code: "AAAA-AAAA", account: "duke" },
					{ authorization: `Bearer ${OPERATOR_KEY}` },
				),
			);
			statuses.push(res.status);
			if (i === 0) expect(await res.json()).toEqual({ error: "no such code" });
		}
		expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
	});
});
