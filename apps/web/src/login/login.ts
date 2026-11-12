import { loadMe } from "../session/session.ts";

/**
 * Login by code: the page asks for a code, shows it, and polls. An approver
 * (the operator, or a logged-in account) approves the code; then the poll
 * sets the session cookie. An approver who does not know the code denies it;
 * then the poll says `denied`. Only this browser holds the pending-login cookie.
 */
export type CodeStart =
	| { kind: "code"; code: string; expiresAt: string }
	| { kind: "error"; message: string };

export type CodePoll =
	| { kind: "pending"; code?: string; expiresAt?: string }
	| { kind: "expired" }
	| { kind: "denied" }
	| { kind: "ok"; account: string }
	| { kind: "error"; message: string };

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
	return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function startCode(
	fetcher: typeof fetch = fetch,
): Promise<CodeStart> {
	try {
		const res = await fetcher("/api/auth/login/start", {
			method: "POST",
			credentials: "same-origin",
		});
		const b = await jsonOf(res);
		if (!res.ok || typeof b.code !== "string")
			return {
				kind: "error",
				message: String(b.error ?? `HTTP ${res.status}`),
			};
		return { kind: "code", code: b.code, expiresAt: String(b.expiresAt) };
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
}

export async function pollCode(
	fetcher: typeof fetch = fetch,
): Promise<CodePoll> {
	try {
		const res = await fetcher("/api/auth/login/poll", {
			credentials: "same-origin",
			cache: "no-store",
		});
		const b = await jsonOf(res);
		if (!res.ok)
			return {
				kind: "error",
				message: String(b.error ?? `HTTP ${res.status}`),
			};
		if (b.status === "approved" && typeof b.account === "string")
			return { kind: "ok", account: b.account };
		if (b.status === "pending")
			return typeof b.code === "string" && typeof b.expiresAt === "string"
				? { kind: "pending", code: b.code, expiresAt: b.expiresAt }
				: { kind: "pending" };
		if (b.status === "denied") return { kind: "denied" };
		return { kind: "expired" };
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
}

/**
 * On page load: resume the pending login of this browser (a reload, or a tab
 * the browser put to sleep, keeps its code), else start a new code. A resume
 * may find the code already approved: then the poll has logged in.
 */
export async function resumeOrStart(
	fetcher: typeof fetch = fetch,
): Promise<CodeStart | { kind: "ok"; account: string } | { kind: "denied" }> {
	const r = await pollCode(fetcher);
	if (r.kind === "ok" || r.kind === "denied") return r;
	if (r.kind === "pending" && r.code && r.expiresAt)
		return { kind: "code", code: r.code, expiresAt: r.expiresAt };
	return startCode(fetcher);
}

/** Seconds left until `expiresAt`, never below 0. */
export function secondsLeft(expiresAt: string, now = Date.now()): number {
	return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** 125 -> "2:05". */
export const clock = (s: number) =>
	`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * A poll said the code is used or expired. Another /login tab of this
 * browser may have collected the approved login (all tabs share the
 * pending-login cookie): if the browser has a session now, it is logged in.
 */
export async function usedOrExpired(
	fetcher: typeof fetch = fetch,
): Promise<{ kind: "ok"; account: string } | { kind: "expired" }> {
	const me = await loadMe(fetcher);
	return me.kind === "ok"
		? { kind: "ok", account: me.me.account }
		: { kind: "expired" };
}

/** One tab's login moves every /login tab of this browser to the board. */
export const LOGIN_CHANNEL = "mm-login";
