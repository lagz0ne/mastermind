/**
 * The browser session: who is logged in (`GET /api/people/me`), the display
 * name and the CSRF token for writes (`GET /api/auth/me`), and log out. One small store that
 * the router guard fills and the account menu reads.
 */
import type { Me, PeopleSetup } from "@mastermind/core";
import { useSyncExternalStore } from "react";

/**
 * The logged-in account. `displayName` is the name as it was typed at login
 * (e.g. Lagz0ne for the id lagz0ne); absent when it equals the id or is unknown.
 */
export type SessionMe = Me & { displayName?: string };

/** The name to show for the session: the display name, else the id. */
export function nameOf(me: SessionMe): string {
	return me.displayName || me.account;
}

export type MeResult =
	| { kind: "ok"; me: SessionMe }
	/** No session: go to /login. */
	| { kind: "anon" }
	/** The server cannot say (auth unconfigured or starting, network down). */
	| { kind: "error"; message: string };

type Fetch = typeof fetch;

async function errorOf(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as {
		error?: string;
	} | null;
	return body?.error ?? `HTTP ${res.status}`;
}

export async function loadMe(fetcher: Fetch = fetch): Promise<MeResult> {
	try {
		const res = await fetcher("/api/people/me", { credentials: "same-origin" });
		if (res.status === 401) return { kind: "anon" };
		if (!res.ok) return { kind: "error", message: await errorOf(res) };
		const me = (await res.json()) as Me;
		const displayName =
			me.auth === "on" ? await loadDisplayName(fetcher) : undefined;
		return {
			kind: "ok",
			me:
				displayName && displayName !== me.account ? { ...me, displayName } : me,
		};
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
}

/** `GET /api/auth/me` displayName; undefined when the api cannot say. */
async function loadDisplayName(fetcher: Fetch): Promise<string | undefined> {
	try {
		const res = await fetcher("/api/auth/me", { credentials: "same-origin" });
		if (!res.ok) return undefined;
		const body = (await res.json()) as { displayName?: unknown };
		return typeof body.displayName === "string" ? body.displayName : undefined;
	} catch {
		return undefined;
	}
}

export async function loadSetup(
	fetcher: Fetch = fetch,
): Promise<PeopleSetup | null> {
	try {
		const res = await fetcher("/api/people/setup");
		return res.ok ? ((await res.json()) as PeopleSetup) : null;
	} catch {
		return null;
	}
}

// --- store ---------------------------------------------------------------

let current: SessionMe | null = null;
let csrf: string | null = null;
const listeners = new Set<() => void>();

export function setMe(me: SessionMe | null): void {
	if (me?.account !== current?.account) csrf = null;
	current = me;
	for (const l of listeners) l();
}

export function getMe(): SessionMe | null {
	return current;
}

/** The logged-in account, or null. */
export function useMe(): SessionMe | null {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => current,
	);
}

/**
 * Pages a logged-out visitor sees (no session check). The header shows only
 * the wordmark there: no nav, no New work, no account menu.
 */
export function isPublicPath(pathname: string): boolean {
	return pathname === "/login" || pathname.startsWith("/login/");
}

/**
 * Router guard: on /login nothing; elsewhere the session is checked once and
 * kept. Returns "login" when the visitor must log in.
 */
export async function ensureSession(
	pathname: string,
	fetcher: Fetch = fetch,
): Promise<"ok" | "login"> {
	if (isPublicPath(pathname) || current) return "ok";
	const r = await loadMe(fetcher);
	if (r.kind === "anon") return "login";
	if (r.kind === "ok") setMe(r.me);
	// On error the page loads and shows the api's own error.
	return "ok";
}

// --- writes ----------------------------------------------------------------

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function csrfToken(fetcher: Fetch): Promise<string> {
	if (csrf) return csrf;
	const res = await fetcher("/api/auth/me", { credentials: "same-origin" });
	if (!res.ok) throw new ApiError(res.status, await errorOf(res));
	csrf = ((await res.json()) as { csrf: string }).csrf;
	return csrf;
}

/** A write to the api with the session's CSRF header. Returns the JSON reply. */
export async function send<T>(
	method: "POST" | "DELETE",
	path: string,
	body?: unknown,
	fetcher: Fetch = fetch,
): Promise<T> {
	const headers: Record<string, string> = {
		"x-csrf-token": await csrfToken(fetcher),
	};
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await fetcher(path, {
		method,
		headers,
		credentials: "same-origin",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) throw new ApiError(res.status, await errorOf(res));
	return (await res.json()) as T;
}

export async function logout(fetcher: Fetch = fetch): Promise<void> {
	await fetcher("/api/auth/logout", {
		method: "POST",
		credentials: "same-origin",
	}).catch(() => {});
	setMe(null);
}
