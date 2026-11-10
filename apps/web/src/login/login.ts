/**
 * The login link is `/login#<token>`. The token sits in the fragment, so it
 * never reaches a server log or a Referer header. The page takes it once,
 * removes it from the address bar, and POSTs it; the reply sets the session
 * cookie.
 */
export type LoginResult =
	| { kind: "no-token" }
	| { kind: "ok"; account: string }
	| { kind: "refused" }
	| { kind: "error"; message: string };

/** The token in a location hash (`#mml_...`), or null. */
export function tokenFromHash(hash: string): string | null {
	const token = hash.replace(/^#/, "").trim();
	return token.startsWith("mml_") ? token : null;
}

export async function login(
	token: string | null,
	fetcher: typeof fetch = fetch,
): Promise<LoginResult> {
	if (!token) return { kind: "no-token" };
	try {
		const res = await fetcher("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
			credentials: "same-origin",
		});
		if (res.status === 401) return { kind: "refused" };
		const body = (await res.json().catch(() => ({}))) as {
			account?: string;
			error?: string;
		};
		if (!res.ok || !body.account)
			return { kind: "error", message: body.error ?? `HTTP ${res.status}` };
		return { kind: "ok", account: body.account };
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
}
