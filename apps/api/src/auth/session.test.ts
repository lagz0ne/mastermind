import { describe, expect, test } from "bun:test";
import { MemoryKv } from "./memory-kv.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "./routes.ts";
import { Auth } from "./service.ts";
import {
	accountGuard,
	LOCAL_ACCOUNT,
	requireAccountFromEnv,
} from "./session.ts";

const SECRET = "test-secret";

async function setup() {
	const auth = new Auth({
		accounts: new MemoryKv(),
		serviceAccounts: new MemoryKv(),
		tokens: new MemoryKv(),
		sessions: new MemoryKv(),
	});
	const token = (await auth.bootstrap()) as string;
	const { sessionId } = (await auth.login(token)) as { sessionId: string };
	const cookie = `${SESSION_COOKIE}=${sessionId}`;
	return { auth, cookie, guard: accountGuard(auth, SECRET) };
}

const req = (method: string, headers: Record<string, string> = {}) =>
	new Request("https://mm.example/api/x", { method, headers });

describe("accountGuard", () => {
	test("a session cookie gives its account on a read", async () => {
		const { guard, cookie } = await setup();
		expect(await guard(req("GET", { cookie }))).toBe("admin");
	});

	test("no or unknown session: 401", async () => {
		const { guard } = await setup();
		const none = (await guard(req("GET"))) as Response;
		expect(none.status).toBe(401);
		const bad = (await guard(
			req("GET", { cookie: `${SESSION_COOKIE}=nope` }),
		)) as Response;
		expect(bad.status).toBe(401);
	});

	test("a write needs a valid CSRF header", async () => {
		const { guard, cookie } = await setup();
		const missing = (await guard(req("PUT", { cookie }))) as Response;
		expect(missing.status).toBe(403);
		const wrong = (await guard(
			req("POST", { cookie, [CSRF_HEADER]: "x" }),
		)) as Response;
		expect(wrong.status).toBe(403);
		const csrf = Bun.CSRF.generate(SECRET);
		expect(await guard(req("POST", { cookie, [CSRF_HEADER]: csrf }))).toBe(
			"admin",
		);
	});

	test("a getter that has no Auth yet: 503", async () => {
		const guard = accountGuard(() => null, SECRET);
		expect(((await guard(req("GET"))) as Response).status).toBe(503);
	});
});

describe("requireAccountFromEnv", () => {
	test("auth configured wins over AUTH_DISABLED", async () => {
		const own = async () => "alice";
		const guard = requireAccountFromEnv(
			{ requireAccount: own },
			{ AUTH_DISABLED: "1" },
		);
		expect(guard).toBe(own);
	});

	test("AUTH_DISABLED=1 without auth: account local", async () => {
		const guard = requireAccountFromEnv(null, { AUTH_DISABLED: "1" });
		expect(await guard(req("POST"))).toBe(LOCAL_ACCOUNT);
	});

	test("neither: 503, never open", async () => {
		const guard = requireAccountFromEnv(null, {});
		expect(((await guard(req("GET"))) as Response).status).toBe(503);
	});
});
