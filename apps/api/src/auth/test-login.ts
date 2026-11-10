import type { Approver, Auth } from "./service.ts";

/** Test helper: a full login by code; returns the session id. */
export async function loginAs(
	auth: Auth,
	account: string,
	approver: Approver = { kind: "operator" },
): Promise<string> {
	const { code, cookie } = await auth.startLogin("test");
	await auth.approveLogin(code, account, approver);
	const r = await auth.pollLogin(cookie);
	if (r.status !== "approved") throw new Error(`login ${r.status}`);
	return r.sessionId;
}

/** Test helper: `by` approves a login for the new account `account`. */
export const inviteAs = (auth: Auth, by: string, account: string) =>
	loginAs(auth, account, { kind: "account", account: by });
