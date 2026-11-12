// Calls to /api/beads and /api/activity. Writes carry the CSRF token from
// GET /api/auth/me; with auth off (AUTH_DISABLED, local dev) there is none.
import type {
	ActivityPage,
	Bead,
	BeadComment,
	BeadDetail,
	NewWork,
} from "@mastermind/core";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

let csrf: Promise<string | null> | null = null;

export function csrfToken(): Promise<string | null> {
	csrf ??= fetch("/api/auth/me")
		.then(async (res) =>
			res.ok ? (((await res.json()) as { csrf?: string }).csrf ?? null) : null,
		)
		.catch(() => null);
	return csrf;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
			detail?: string;
		} | null;
		// A stale token: fetch a new one on the next write.
		if (res.status === 403) csrf = null;
		throw new ApiError(
			res.status,
			body?.detail ?? body?.error ?? `HTTP ${res.status}`,
		);
	}
	return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const token = await csrfToken();
	if (token) headers["x-csrf-token"] = token;
	return call<T>(path, { method: "POST", headers, body: JSON.stringify(body) });
}

const beadPath = (id: string) => `/api/beads/${encodeURIComponent(id)}`;

export const api = {
	create: (work: NewWork) => post<Bead>("/api/beads", work),
	detail: (id: string) => call<BeadDetail>(beadPath(id)),
	note: (id: string, text: string) =>
		post<BeadComment>(`${beadPath(id)}/comments`, { text }),
	reopen: (id: string, reason?: string) =>
		post<Bead>(`${beadPath(id)}/reopen`, reason ? { reason } : {}),
	close: (id: string, reason?: string) =>
		post<Bead>(`${beadPath(id)}/close`, reason ? { reason } : {}),
	activity: (limit = 200, before?: number) =>
		call<ActivityPage>(
			`/api/activity?limit=${limit}${before === undefined ? "" : `&before=${before}`}`,
		),
};
