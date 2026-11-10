import { describe, expect, test } from "bun:test";
import { MemoryKv } from "./memory-kv.ts";
import { authRoutes, CSRF_HEADER, SESSION_COOKIE } from "./routes.ts";
import { Auth } from "./service.ts";

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
	const token = (await s.auth.bootstrap()) as string;
	const res = await s.routes["/api/auth/login"].POST(post({ token }));
	const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const me = await s.routes["/api/auth/me"].GET(
		new Request(`${URL_BASE}/x`, { headers: { cookie } }),
	);
	const { csrf } = (await me.json()) as { csrf: string };
	return { ...s, token, res, cookie, csrf };
}

describe("auth routes", () => {
	test("login sets a secure HttpOnly session cookie, once", async () => {
		const { res, token, routes } = await login();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ account: "admin" });
		const set = res.headers.get("set-cookie") ?? "";
		expect(set).toStartWith(`${SESSION_COOKIE}=`);
		expect(set).toContain("HttpOnly");
		expect(set).toContain("Secure");
		expect(set).toContain("SameSite=Lax");
		const again = await routes["/api/auth/login"].POST(post({ token }));
		expect(again.status).toBe(401);
	});

	test("login needs a JSON body with a token", async () => {
		const { routes } = setup();
		expect((await routes["/api/auth/login"].POST(post({}))).status).toBe(400);
		const form = new Request(`${URL_BASE}/x`, {
			method: "POST",
			body: "token=x",
		});
		expect((await routes["/api/auth/login"].POST(form)).status).toBe(400);
	});

	test("me needs a session", async () => {
		const { routes } = setup();
		const res = await routes["/api/auth/me"].GET(new Request(`${URL_BASE}/x`));
		expect(res.status).toBe(401);
	});

	test("minting tokens needs the CSRF header", async () => {
		const { routes, cookie, csrf } = await login();
		const tokens = routes["/api/auth/tokens"].POST;
		expect((await tokens(post({ kind: "login" }, { cookie }))).status).toBe(
			403,
		);
		expect(
			(await tokens(post({ kind: "login" }, { cookie, [CSRF_HEADER]: "bad" })))
				.status,
		).toBe(403);
		const ok = await tokens(
			post({ kind: "login" }, { cookie, [CSRF_HEADER]: csrf }),
		);
		expect(ok.status).toBe(201);
		const { url } = (await ok.json()) as { url: string };
		expect(url).toStartWith(`${URL_BASE}/login#mml_`);
	});

	test("invite: 201 with a login URL; taken id: 409; bad kind: 400", async () => {
		const { routes, cookie, csrf } = await login();
		const h = { cookie, [CSRF_HEADER]: csrf };
		const tokens = routes["/api/auth/tokens"].POST;
		const res = await tokens(post({ kind: "invite", account: "bob" }, h));
		expect(res.status).toBe(201);
		expect(((await res.json()) as { url: string }).url).toContain(
			"/login#mml_",
		);
		expect(
			(await tokens(post({ kind: "invite", account: "admin" }, h))).status,
		).toBe(409);
		expect(
			(await tokens(post({ kind: "invite", account: "B B" }, h))).status,
		).toBe(400);
		expect((await tokens(post({ kind: "x" }, h))).status).toBe(400);
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
	const res = await routes["/api/auth/login"].POST(post({ token: "mml_x" }));
	expect(res.status).toBe(503);
});
