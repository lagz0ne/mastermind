import { describe, expect, test } from "bun:test";
import { MemoryKv } from "./memory-kv.ts";
import { parseCredential, sha256 } from "./secrets.ts";
import {
	type Account,
	Auth,
	AuthError,
	type AuthStores,
	type ServiceAccount,
	type ServiceAccountView,
	type Session,
	type TokenRecord,
} from "./service.ts";

function setup(onRevoke?: (sa: ServiceAccountView) => Promise<void>) {
	const stores = {
		accounts: new MemoryKv<Account>(),
		serviceAccounts: new MemoryKv<ServiceAccount>(),
		tokens: new MemoryKv<TokenRecord>(),
		sessions: new MemoryKv<Session>(),
	} satisfies AuthStores;
	return { stores, auth: new Auth(stores, { onRevoke }) };
}

async function loggedIn() {
	const s = setup();
	const token = await s.auth.bootstrap();
	if (!token) throw new Error("no bootstrap token");
	const login = await s.auth.login(token);
	if (!login) throw new Error("login failed");
	return { ...s, sessionId: login.sessionId };
}

describe("bootstrap", () => {
	test("mints a login token when there is no account", async () => {
		const { auth } = setup();
		expect(await auth.bootstrap()).toStartWith("mml_");
	});

	test("every start rotates: the previous token is refused", async () => {
		const { auth, stores } = setup();
		const first = (await auth.bootstrap()) as string;
		const second = (await auth.bootstrap()) as string;
		expect(second).toStartWith("mml_");
		expect(second).not.toBe(first);
		expect(await auth.login(first)).toBeNull();
		expect((await auth.login(second))?.account).toBe("admin");
		// Only the marker is left; the account now exists, so no more tokens.
		expect(await stores.tokens.list()).toEqual(["bootstrap"]);
		expect(await auth.bootstrap()).toBeNull();
	});

	test("of many replicas, one mints and no loser token stays valid", async () => {
		const { auth, stores } = setup();
		const tokens = await Promise.all(
			Array.from({ length: 5 }, () => auth.bootstrap()),
		);
		expect(tokens.filter(Boolean)).toHaveLength(1);
		expect(await stores.tokens.list("login.*")).toHaveLength(1);
	});

	test("rotation from an older marker without a key drops its token", async () => {
		const { auth, stores } = setup();
		const old = (await auth.bootstrap()) as string;
		await stores.tokens.put("bootstrap", { kind: "bootstrap" });
		const fresh = (await auth.bootstrap()) as string;
		expect(await auth.login(old)).toBeNull();
		expect(await auth.login(fresh)).not.toBeNull();
	});

	test("does nothing when an account exists", async () => {
		const { stores, auth } = setup();
		await stores.accounts.create("alice", {
			id: "alice",
			createdAt: "",
			invitedBy: null,
		});
		expect(await auth.bootstrap()).toBeNull();
		expect(await stores.tokens.list()).toEqual([]);
	});
});

describe("login", () => {
	test("the first-start token works exactly once", async () => {
		const { auth, stores } = setup();
		const token = (await auth.bootstrap()) as string;
		const first = await auth.login(token);
		expect(first?.account).toBe("admin");
		expect(await auth.session(first?.sessionId)).toBe("admin");
		expect(await auth.login(token)).toBeNull();
		expect((await stores.accounts.get("admin"))?.value.invitedBy).toBeNull();
	});

	test("N parallel logins with one token: one winner", async () => {
		const { auth } = setup();
		const token = (await auth.bootstrap()) as string;
		const results = await Promise.all(
			Array.from({ length: 20 }, () => auth.login(token)),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	test("stores only hashes of tokens and sessions", async () => {
		const { auth, stores } = setup();
		const token = (await auth.bootstrap()) as string;
		expect(await stores.tokens.list()).toContain(`login.${sha256(token)}`);
		const { sessionId } = (await auth.login(token)) as { sessionId: string };
		expect(await stores.sessions.list()).toEqual([sha256(sessionId)]);
	});

	test("unknown, malformed and enrol tokens are refused", async () => {
		const { auth, sessionId } = await loggedIn();
		const account = (await auth.session(sessionId)) as string;
		const enrol = await auth.enrolToken(account, "laptop");
		expect(await auth.login("mml_nope")).toBeNull();
		expect(await auth.login("garbage")).toBeNull();
		expect(await auth.login(enrol)).toBeNull();
		// The enrol token is not burnt by the wrong use.
		expect(await auth.enrol(enrol)).not.toBeNull();
	});

	test("logout ends the session", async () => {
		const { auth, sessionId } = await loggedIn();
		await auth.logout(sessionId);
		expect(await auth.session(sessionId)).toBeNull();
		expect(await auth.session(null)).toBeNull();
	});
});

describe("invite and login links", () => {
	test("an account invites a new account; the token creates it once", async () => {
		const { auth, stores } = await loggedIn();
		const token = await auth.invite("admin", "bob");
		const res = await auth.login(token);
		expect(res?.account).toBe("bob");
		expect((await stores.accounts.get("bob"))?.value.invitedBy).toBe("admin");
		expect(await auth.login(token)).toBeNull();
	});

	test("refuses bad and taken account ids", async () => {
		const { auth } = await loggedIn();
		await expect(auth.invite("admin", "Bob.x")).rejects.toThrow(AuthError);
		await expect(auth.invite("admin", "admin")).rejects.toThrow("exists");
	});

	test("a second invite for the same id loses at login", async () => {
		const { auth } = await loggedIn();
		const a = await auth.invite("admin", "carol");
		const b = await auth.invite("admin", "carol");
		expect((await auth.login(a))?.account).toBe("carol");
		await expect(auth.login(b)).rejects.toThrow("exists");
	});

	test("a login token for an existing account gives a second session", async () => {
		const { auth, sessionId } = await loggedIn();
		const res = await auth.login(await auth.loginToken("admin"));
		expect(res?.account).toBe("admin");
		expect(res?.sessionId).not.toBe(sessionId);
		await expect(auth.loginToken("ghost")).rejects.toThrow("no account");
	});
});

describe("service accounts", () => {
	test("enrol once, authorize with the credential", async () => {
		const { auth, stores } = await loggedIn();
		const token = await auth.enrolToken("admin", "laptop");
		const res = await auth.enrol(token);
		expect(res?.serviceAccount).toMatchObject({
			account: "admin",
			name: "laptop",
		});
		expect(await auth.enrol(token)).toBeNull();

		const credential = res?.credential as string;
		expect(parseCredential(credential)?.account).toBe("admin");
		expect(await auth.authorize(credential)).toEqual(
			res?.serviceAccount as ServiceAccountView,
		);
		// Only the hash of the secret is stored.
		const [key] = await stores.serviceAccounts.list();
		const stored = await stores.serviceAccounts.get(key as string);
		expect(JSON.stringify(stored)).not.toContain(
			parseCredential(credential)?.secret as string,
		);
	});

	test("N parallel enrols with one token: one winner", async () => {
		const { auth } = await loggedIn();
		const token = await auth.enrolToken("admin", "ci");
		const results = await Promise.all(
			Array.from({ length: 20 }, () => auth.enrol(token)),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await auth.serviceAccounts("admin")).toHaveLength(1);
	});

	test("a wrong secret or a forged account is refused", async () => {
		const { auth } = await loggedIn();
		const res = await auth.enrol(await auth.enrolToken("admin", "laptop"));
		const c = parseCredential(res?.credential as string);
		if (!c) throw new Error("bad credential");
		expect(await auth.authorize(`mms_admin_${c.id}_wrong`)).toBeNull();
		expect(await auth.authorize(`mms_bob_${c.id}_${c.secret}`)).toBeNull();
		expect(await auth.authorize("mml_x")).toBeNull();
	});

	test("bad service account names are refused", async () => {
		const { auth } = await loggedIn();
		await expect(auth.enrolToken("admin", "my laptop")).rejects.toThrow(
			AuthError,
		);
	});

	test("revoke deletes, refuses the credential, and calls onRevoke", async () => {
		const revoked: ServiceAccountView[] = [];
		const s = setup(async (sa) => {
			revoked.push(sa);
		});
		const token = (await s.auth.bootstrap()) as string;
		await s.auth.login(token);
		const res = await s.auth.enrol(await s.auth.enrolToken("admin", "laptop"));
		const sa = res?.serviceAccount as ServiceAccountView;
		expect(await s.auth.revoke("bob", sa.id)).toBe(false);
		expect(await s.auth.revoke("admin", sa.id)).toBe(true);
		expect(revoked).toEqual([sa]);
		expect(await s.auth.authorize(res?.credential as string)).toBeNull();
		expect(await s.auth.serviceAccounts("admin")).toEqual([]);
	});

	test("lists only the account's own service accounts", async () => {
		const { auth } = await loggedIn();
		await auth.login(await auth.invite("admin", "bob"));
		await auth.enrol(await auth.enrolToken("admin", "a1"));
		await auth.enrol(await auth.enrolToken("bob", "b1"));
		expect((await auth.serviceAccounts("admin")).map((s) => s.name)).toEqual([
			"a1",
		]);
	});
});

describe("listing", () => {
	test("every service account, and every account with its inviter, oldest first", async () => {
		let t = 0;
		const s = setup();
		const auth = new Auth(s.stores, {
			now: () => new Date(Date.UTC(2026, 10, 10, 8, 0, t++)),
		});
		await auth.login((await auth.bootstrap()) as string);
		await auth.login(await auth.invite("admin", "bob"));
		await auth.enrol(await auth.enrolToken("admin", "a1"));
		await auth.enrol(await auth.enrolToken("bob", "b1"));
		const names = (await auth.serviceAccounts()).map((x) => x.name).sort();
		expect(names).toEqual(["a1", "b1"]);
		expect((await auth.accounts()).map((a) => [a.id, a.invitedBy])).toEqual([
			["admin", null],
			["bob", "admin"],
		]);
	});
});

describe("login by code", () => {
	function clocked() {
		let t = Date.parse("2026-11-10T10:00:00Z");
		const stores = {
			accounts: new MemoryKv<Account>(),
			serviceAccounts: new MemoryKv<ServiceAccount>(),
			tokens: new MemoryKv<TokenRecord>(),
			sessions: new MemoryKv<Session>(),
		} satisfies AuthStores;
		const auth = new Auth(stores, { now: () => new Date(t) });
		return { auth, stores, advance: (ms: number) => (t += ms) };
	}
	const operator = { kind: "operator" } as const;

	test("the operator approves; the starting browser gets a session and the account", async () => {
		const { auth, stores } = clocked();
		const { code, cookie, expiresAt } = await auth.startLogin("Firefox");
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
		expect(expiresAt).toBe("2026-11-10T10:10:00.000Z");
		expect(await auth.pollLogin(cookie)).toMatchObject({ status: "pending" });
		const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`;
		expect(await auth.approveLogin(typed, "duke", operator)).toEqual({
			account: "duke",
			created: true,
			ageSeconds: 0,
			userAgent: "Firefox",
		});
		const r = await auth.pollLogin(cookie);
		if (r.status !== "approved") throw new Error(r.status);
		expect(await auth.session(r.sessionId)).toBe("duke");
		expect((await stores.accounts.get("duke"))?.value.invitedBy).toBeNull();
		// Single use: the code and the cookie are spent.
		expect(await auth.pollLogin(cookie)).toEqual({ status: "expired" });
		await expect(auth.approveLogin(code, "duke", operator)).rejects.toThrow(
			"no such code",
		);
	});

	test("the code alone is not enough: another browser gets no session", async () => {
		const { auth } = clocked();
		const { code } = await auth.startLogin("a");
		await auth.approveLogin(code, "duke", operator);
		expect(await auth.pollLogin(`${code}.forged`)).toEqual({
			status: "expired",
		});
		expect(await auth.pollLogin(code)).toEqual({ status: "expired" });
	});

	test("an expired code is refused, wrong codes look the same", async () => {
		const { auth, advance } = clocked();
		const { code, cookie } = await auth.startLogin("a");
		advance(10 * 60 * 1000);
		await expect(auth.approveLogin(code, "duke", operator)).rejects.toThrow(
			"no such code",
		);
		expect(await auth.pollLogin(cookie)).toEqual({ status: "expired" });
		for (const wrong of ["AAAA-AAAA", "short", "0000-0000"])
			await expect(auth.approveLogin(wrong, "duke", operator)).rejects.toThrow(
				"no such code",
			);
	});

	test("race: N approvals and N polls give one session", async () => {
		const { auth } = clocked();
		const { code, cookie } = await auth.startLogin("a");
		const approvals = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) =>
				auth.approveLogin(code, `user-${i}`, operator),
			),
		);
		expect(approvals.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const polls = await Promise.all(
			Array.from({ length: 20 }, () => auth.pollLogin(cookie)),
		);
		expect(polls.filter((p) => p.status === "approved")).toHaveLength(1);
		expect(await auth.accounts()).toHaveLength(1);
	});

	test("an account approves for itself or for a new name, not for another account", async () => {
		const { auth } = clocked();
		const first = await auth.startLogin("a");
		await auth.approveLogin(first.code, "duke", operator);
		await auth.pollLogin(first.cookie);

		const self = await auth.startLogin("phone");
		expect(
			await auth.approveLogin(self.code, "duke", {
				kind: "account",
				account: "duke",
			}),
		).toMatchObject({ account: "duke", created: false });
		expect(await auth.pollLogin(self.cookie)).toMatchObject({
			status: "approved",
			account: "duke",
		});

		const invite = await auth.startLogin("c");
		await auth.approveLogin(invite.code, "carol", {
			kind: "account",
			account: "duke",
		});
		expect(await auth.pollLogin(invite.cookie)).toMatchObject({
			account: "carol",
		});
		expect(
			(await auth.accounts()).find((a) => a.id === "carol")?.invitedBy,
		).toBe("duke");

		const other = await auth.startLogin("d");
		await expect(
			auth.approveLogin(other.code, "carol", {
				kind: "account",
				account: "duke",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			auth.approveLogin(other.code, "Bad Name", operator),
		).rejects.toMatchObject({ code: "bad_request" });
	});
});
