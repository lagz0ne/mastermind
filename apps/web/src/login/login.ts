/**
 * Login by code: the page asks for a code, shows it, and polls. An approver
 * (the operator, or a logged-in account) approves the code; then the poll
 * sets the session cookie. Only this browser holds the pending-login cookie.
 */
export type CodeStart =
	| { kind: "code"; code: string; expiresAt: string }
	| { kind: "error"; message: string };

export type CodePoll =
	| { kind: "pending" }
	| { kind: "expired" }
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
		if (b.status === "pending") return { kind: "pending" };
		return { kind: "expired" };
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
}

/** Seconds left until `expiresAt`, never below 0. */
export function secondsLeft(expiresAt: string, now = Date.now()): number {
	return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** 125 -> "2:05". */
export const clock = (s: number) =>
	`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
