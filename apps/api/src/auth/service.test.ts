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
import { inviteAs, loginAs } from "./test-login.ts";

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
	const sessionId = await loginAs(s.auth, "admin");
	return { ...s, sessionId };
}

describe("sessions", () => {
	test("stores only hashes of codes and sessions", async () => {
		const { auth, stores } = setup();
		const { code, cookie } = await auth.startLogin("a");
		expect(await stores.tokens.list()).toEqual([`pending.${sha256(code)}`]);
		expect(JSON.stringify(await stores.tokens.list())).not.toContain(
			cookie.split(".")[1] as string,
		);
		await auth.approveLogin(code, "admin", { kind: "operator" });
		const r = await auth.pollLogin(cookie);
		if (r.status !== "approved") throw new Error(r.status);
		expect(await stores.sessions.list()).toEqual([sha256(r.sessionId)]);
	});

	test("enrol tokens do not log in", async () => {
		const { auth } = await loggedIn();
		const enrol = await auth.enrolToken("admin", "laptop");
		await expect(
			auth.approveLogin(enrol, "admin", { kind: "operator" }),
		).rejects.toThrow("no such code");
		expect(await auth.pollLogin(enrol)).toEqual({ status: "expired" });
		expect(await auth.enrol(enrol)).not.toBeNull();
	});

	test("logout ends the session", async () => {
		const { auth, sessionId } = await loggedIn();
		await auth.logout(sessionId);
		expect(await auth.session(sessionId)).toBeNull();
		expect(await auth.session(null)).toBeNull();
	});

	test("a second invite of the same name loses when it is collected", async () => {
		const { auth } = await loggedIn();
		const a = await auth.startLogin("a");
		const b = await auth.startLogin("b");
		const by = { kind: "account", account: "admin" } as const;
		await auth.approveLogin(a.code, "carol", by);
		await auth.approveLogin(b.code, "carol", by);
		expect(await auth.pollLogin(a.cookie)).toMatchObject({ account: "carol" });
		await expect(auth.pollLogin(b.cookie)).rejects.toThrow("exists");
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
		await loginAs(s.auth, "admin");
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
		await inviteAs(auth, "admin", "bob");
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
		await loginAs(auth, "admin");
		await inviteAs(auth, "admin", "bob");
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
		).rejects.toMatchObject({
			code: "bad_request",
			message: "account id: a-z, 0-9 and -, at most 32",
		});
	});

	test("a name in any case: the id is lowercase, the display name keeps the case", async () => {
		const { auth, stores } = clocked();
		const first = await auth.startLogin("a");
		expect(
			await auth.approveLogin(first.code, " Lagz0ne ", operator),
		).toMatchObject({ account: "lagz0ne", created: true });
		const r = await auth.pollLogin(first.cookie);
		if (r.status !== "approved") throw new Error(r.status);
		expect(r.account).toBe("lagz0ne");
		expect(await auth.session(r.sessionId)).toBe("lagz0ne");
		expect((await stores.accounts.get("lagz0ne"))?.value).toMatchObject({
			id: "lagz0ne",
			displayName: "Lagz0ne",
		});

		// Lowercase typing logs in to the same account and keeps the display name.
		const again = await auth.startLogin("b");
		expect(
			await auth.approveLogin(again.code, "lagz0ne", operator),
		).toMatchObject({ account: "lagz0ne", created: false });
		await auth.pollLogin(again.cookie);
		expect((await stores.accounts.get("lagz0ne"))?.value.displayName).toBe(
			"Lagz0ne",
		);

		// The account itself, in a new case: the new display name.
		const self = await auth.startLogin("c");
		await auth.approveLogin(self.code, "LAGZ0NE", {
			kind: "account",
			account: "lagz0ne",
		});
		await auth.pollLogin(self.cookie);
		expect((await stores.accounts.get("lagz0ne"))?.value.displayName).toBe(
			"LAGZ0NE",
		);

		// Another account cannot reach an existing one through its case.
		const other = await auth.startLogin("d");
		await expect(
			auth.approveLogin(other.code, "Lagz0ne", {
				kind: "account",
				account: "duke",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	test("an account made before display names gets one from a mixed-case approval", async () => {
		const { auth, stores } = clocked();
		await stores.accounts.create("lagz0ne", {
			id: "lagz0ne",
			createdAt: "2026-11-10T00:00:00.000Z",
			invitedBy: null,
		});
		const s = await auth.startLogin("a");
		await auth.approveLogin(s.code, "Lagz0ne", operator);
		expect(await auth.pollLogin(s.cookie)).toMatchObject({
			status: "approved",
		});
		expect((await stores.accounts.get("lagz0ne"))?.value).toEqual({
			id: "lagz0ne",
			displayName: "Lagz0ne",
			createdAt: "2026-11-10T00:00:00.000Z",
			invitedBy: null,
		});
	});
});
