import { beforeEach, describe, expect, test } from "bun:test";
import {
	ApiError,
	ensureSession,
	getMe,
	isPublicPath,
	loadMe,
	logout,
	nameOf,
	send,
	setMe,
} from "./session.ts";

type Call = { url: string; init?: RequestInit };

function fake(routes: Record<string, [number, unknown]>) {
	const calls: Call[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const [status, body] = routes[`${init?.method ?? "GET"} ${url}`] ?? [
			404,
			{ error: "not found" },
		];
		return Response.json(body, { status });
	}) as unknown as typeof fetch;
	return { fetcher, calls };
}

beforeEach(() => setMe(null));

describe("loadMe", () => {
	test("ok, anon on 401, error otherwise", async () => {
		const me = { account: "admin", auth: "on" };
		expect(
			await loadMe(fake({ "GET /api/people/me": [200, me] }).fetcher),
		).toEqual({ kind: "ok", me } as never);
		expect(
			await loadMe(fake({ "GET /api/people/me": [401, {}] }).fetcher),
		).toEqual({ kind: "anon" });
		expect(
			await loadMe(
				fake({ "GET /api/people/me": [503, { error: "auth unconfigured" }] })
					.fetcher,
			),
		).toEqual({ kind: "error", message: "auth unconfigured" });
	});
});

describe("display name", () => {
	test("logged in as lagz0ne with displayName Lagz0ne, the top bar reads Lagz0ne", async () => {
		const { fetcher } = fake({
			"GET /api/people/me": [200, { account: "lagz0ne", auth: "on" }],
			"GET /api/auth/me": [
				200,
				{ account: "lagz0ne", displayName: "Lagz0ne", csrf: "t" },
			],
		});
		expect(await ensureSession("/board", fetcher)).toBe("ok");
		expect(getMe()).toEqual({
			account: "lagz0ne",
			auth: "on",
			displayName: "Lagz0ne",
		});
		expect(nameOf(getMe() as never)).toBe("Lagz0ne");
	});

	test("the id when there is no other name, auth/me fails, or auth is off", async () => {
		const same = await loadMe(
			fake({
				"GET /api/people/me": [200, { account: "bob", auth: "on" }],
				"GET /api/auth/me": [200, { account: "bob", displayName: "bob" }],
			}).fetcher,
		);
		expect(same).toEqual({ kind: "ok", me: { account: "bob", auth: "on" } });
		const failed = await loadMe(
			fake({
				"GET /api/people/me": [200, { account: "bob", auth: "on" }],
				"GET /api/auth/me": [503, { error: "auth is starting" }],
			}).fetcher,
		);
		expect(failed).toEqual({ kind: "ok", me: { account: "bob", auth: "on" } });
		const off = fake({
			"GET /api/people/me": [200, { account: "admin", auth: "off" }],
		});
		await loadMe(off.fetcher);
		expect(off.calls.map((c) => c.url)).toEqual(["/api/people/me"]);
		expect(nameOf({ account: "bob", auth: "on" })).toBe("bob");
	});
});

describe("isPublicPath", () => {
	test("only /login is public (its header shows the wordmark only)", () => {
		expect(isPublicPath("/login")).toBe(true);
		expect(isPublicPath("/login/")).toBe(true);
		for (const p of ["/", "/board", "/board/mm-1", "/people", "/loginx"])
			expect(isPublicPath(p)).toBe(false);
	});
});

describe("ensureSession", () => {
	test("login page needs nothing; no session sends to /login; a session is kept", async () => {
		const anon = fake({ "GET /api/people/me": [401, {}] });
		expect(await ensureSession("/login", anon.fetcher)).toBe("ok");
		expect(anon.calls).toHaveLength(0);
		expect(await ensureSession("/people", anon.fetcher)).toBe("login");
		const ok = fake({
			"GET /api/people/me": [200, { account: "bob", auth: "on" }],
		});
		expect(await ensureSession("/board", ok.fetcher)).toBe("ok");
		expect(getMe()?.account).toBe("bob");
		const checked = ok.calls.length;
		await ensureSession("/people", ok.fetcher);
		expect(ok.calls).toHaveLength(checked);
	});

	test("an api error lets the page load (it shows the error)", async () => {
		const down = fake({ "GET /api/people/me": [503, { error: "x" }] });
		expect(await ensureSession("/board", down.fetcher)).toBe("ok");
		expect(getMe()).toBeNull();
	});
});

describe("send", () => {
	test("gets the CSRF token once and sends it on writes", async () => {
		setMe({ account: "admin", auth: "on" });
		const f = fake({
			"GET /api/auth/me": [200, { account: "admin", csrf: "t1" }],
			"POST /api/auth/tokens": [201, { token: "mme_x" }],
		});
		await send("POST", "/api/auth/tokens", { kind: "enrol" }, f.fetcher);
		await send("POST", "/api/auth/tokens", { kind: "enrol" }, f.fetcher);
		const writes = f.calls.filter((c) => c.init?.method === "POST");
		expect(writes).toHaveLength(2);
		for (const w of writes)
			expect(new Headers(w.init?.headers).get("x-csrf-token")).toBe("t1");
		expect(f.calls.filter((c) => c.url === "/api/auth/me")).toHaveLength(1);
	});

	test("an api refusal is an ApiError with the status and message", async () => {
		const f = fake({
			"GET /api/auth/me": [200, { csrf: "t" }],
			"POST /api/auth/tokens": [409, { error: "account bob exists" }],
		});
		const err = (await send("POST", "/api/auth/tokens", {}, f.fetcher).catch(
			(e: unknown) => e,
		)) as ApiError;
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(409);
		expect(err.message).toBe("account bob exists");
	});

	test("logout forgets the account", async () => {
		setMe({ account: "admin", auth: "on" });
		await logout(
			fake({ "POST /api/auth/logout": [200, { ok: true }] }).fetcher,
		);
		expect(getMe()).toBeNull();
	});
});
