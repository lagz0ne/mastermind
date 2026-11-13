/**
 * GitHub credentials for the runner (mm-210.67, shared with mm-210.64).
 * Every value stays on the runner machine (the local secret store);
 * Mastermind never receives one.
 *
 * Two ways, chosen in `onboard`:
 *
 *  a. A GitHub App made with the App Manifest flow
 *     (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
 *     the runner serves a small page on a loopback URL that POSTs the manifest
 *     to GitHub; GitHub redirects back with a one-hour code (or the user pastes
 *     it); the runner exchanges it (POST /app-manifests/{code}/conversions) and
 *     stores the app id and private key. Then the user installs the app on the
 *     repos. Per task the runner mints an installation token for ONE repo
 *     (1 h): {@link installationToken}.
 *  b. A fine-grained personal access token with the permissions in
 *     {@link FINE_GRAINED_PERMISSIONS}, stored as GITHUB_TOKEN.
 *
 * Secret layout (agreed with mm-210.64): {@link GITHUB_APP_SECRETS}.
 */
import { createSign, randomBytes } from "node:crypto";

/** The local secret names of the GitHub App. No installation id: it is looked up per repo. */
export const GITHUB_APP_ID = "GITHUB_APP_ID";
export const GITHUB_APP_PRIVATE_KEY = "GITHUB_APP_PRIVATE_KEY";
/** Optional: for the install link. */
export const GITHUB_APP_SLUG = "GITHUB_APP_SLUG";
/**
 * App settings that are public (the id and slug are in the App's URL and
 * page): kept with the secrets, but never redacted from a line (mm-210.87:
 * 'commits by ***[bot]'). The private key stays secret.
 */
export const GITHUB_APP_PUBLIC = [GITHUB_APP_ID, GITHUB_APP_SLUG];
export const GITHUB_APP_SECRETS = [
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
] as const;
/** The local secret name of a fine-grained token (output.ts reads it). */
export const GITHUB_TOKEN = "GITHUB_TOKEN";

/** What the box output needs: write the branch, open the pull request. */
export const APP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	metadata: "read",
} as const;

/** Where to make a fine-grained token, and what to tick. */
export const FINE_GRAINED_URL =
	"https://github.com/settings/personal-access-tokens/new";
export const FINE_GRAINED_PERMISSIONS = [
	"Repository access: Only select repositories (the repos of your environments)",
	"Contents: Read and write (clone, push the branch mm/<item>)",
	"Pull requests: Read and write (open and update the pull request)",
	"Metadata: Read-only (GitHub adds it by itself)",
];

const API = "https://api.github.com";
const WEB = "https://github.com";

export class GitHubError extends Error {
	override name = "GitHubError";
}

export type Fetch = typeof fetch;

/** The App manifest: no webhook, private, only the permissions above. */
export function appManifest(o: {
	name: string;
	redirectUrl: string;
	url?: string;
}): Record<string, unknown> {
	return {
		name: o.name,
		url: o.url ?? "https://github.com/apps",
		redirect_url: o.redirectUrl,
		public: false,
		default_permissions: { ...APP_PERMISSIONS },
		default_events: [],
		hook_attributes: {
			url: "https://example.invalid/no-webhook",
			active: false,
		},
	};
}

/** The GitHub page that takes the manifest: the user's account, or an organization. */
export function manifestTarget(state: string, org?: string): string {
	const base = org
		? `${WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new`
		: `${WEB}/settings/apps/new`;
	return `${base}?state=${encodeURIComponent(state)}`;
}

const esc = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

/** The page on the loopback URL: it POSTs the manifest to GitHub (the flow needs a form POST). */
export function manifestPage(
	manifest: Record<string, unknown>,
	target: string,
): string {
	return `<!doctype html><meta charset="utf-8"><title>Create the Mastermind runner GitHub App</title>
<body style="font-family:system-ui;max-width:40em;margin:3em auto">
<p>This page sends the app manifest to GitHub. GitHub shows the app; click <b>Create GitHub App</b>.</p>
<form id="f" method="post" action="${esc(target)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit()</script>
</body>`;
}

/** A random `state` for the manifest flow. */
export function newState(): string {
	return randomBytes(16).toString("hex");
}

/** The code from a pasted callback URL (`...?code=X&state=Y`) or the bare code. */
export function parseCode(
	input: string,
	state?: string,
): { code: string } | { error: string } {
	const s = input.trim();
	if (!s) return { error: "empty" };
	if (/^https?:\/\//.test(s)) {
		const u = new URL(s);
		const code = u.searchParams.get("code");
		if (!code) return { error: "the URL has no code" };
		const got = u.searchParams.get("state");
		if (state && got && got !== state)
			return { error: "the state does not match (an old or foreign link)" };
		return { code };
	}
	if (!/^[A-Za-z0-9_-]+$/.test(s)) return { error: "not a code" };
	return { code: s };
}

export type ManifestServer = {
	/** The loopback page that starts the flow. */
	url: string;
	/** The redirect URL in the manifest. */
	redirectUrl: string;
	/** The code GitHub sends back. */
	code: Promise<string>;
	stop: () => void;
};

/**
 * Serve the flow on 127.0.0.1 (a free port, or `port`): `/` posts the
 * manifest, `/callback` takes the code (state checked).
 */
export function serveManifest(o: {
	name: string;
	state: string;
	org?: string;
	port?: number;
}): ManifestServer {
	let resolve!: (code: string) => void;
	const code = new Promise<string>((r) => {
		resolve = r;
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: o.port ?? 0,
		fetch(req): Response {
			const u = new URL(req.url);
			if (u.pathname === "/callback") {
				const got = parseCode(u.toString(), o.state);
				if ("error" in got || u.searchParams.get("state") !== o.state)
					return new Response("This link is not for this onboarding run.", {
						status: 400,
					});
				resolve(got.code);
				return new Response(
					"Done. Go back to the terminal: the runner stores the app on this machine.",
				);
			}
			if (u.pathname === "/")
				return new Response(
					manifestPage(
						appManifest({ name: o.name, redirectUrl }),
						manifestTarget(o.state, o.org),
					),
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			return new Response("not found", { status: 404 });
		},
	});
	const url: string = `http://127.0.0.1:${server.port}/`;
	const redirectUrl: string = `${url}callback`;
	return { url, redirectUrl, code, stop: () => void server.stop() };
}

/** What the conversion gives back (only the parts the runner keeps). */
export type CreatedApp = {
	id: number;
	slug: string;
	pem: string;
	owner: string;
	htmlUrl: string;
};

/** POST /app-manifests/{code}/conversions: the new app and its private key. */
export async function exchangeCode(
	code: string,
	f: Fetch = fetch,
): Promise<CreatedApp> {
	const res = await f(
		`${API}/app-manifests/${encodeURIComponent(code)}/conversions`,
		{ method: "POST", headers: ghHeaders() },
	);
	if (!res.ok)
		throw new GitHubError(
			`GitHub refused the code (${res.status}): ${await short(res)}; codes last one hour and work once`,
		);
	const v = (await res.json()) as Record<string, unknown>;
	const owner = v.owner as { login?: string } | undefined;
	if (typeof v.id !== "number" || typeof v.pem !== "string")
		throw new GitHubError("GitHub's answer has no app id or key");
	return {
		id: v.id,
		slug: String(v.slug ?? ""),
		pem: v.pem,
		owner: owner?.login ?? "",
		htmlUrl: String(v.html_url ?? ""),
	};
}

/** Where the user installs the app on the chosen repos. */
export function installUrl(slug: string): string {
	return `${WEB}/apps/${encodeURIComponent(slug)}/installations/new`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The app's JWT (RS256, 9 min; iat 60 s back for clock drift), as GitHub documents. */
export function appJwt(
	appId: string | number,
	pem: string,
	now = Date.now(),
): string {
	const t = Math.floor(now / 1000);
	const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const body = b64url(
		JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(appId) }),
	);
	let sig: Buffer;
	try {
		sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem);
	} catch {
		throw new GitHubError(
			`${GITHUB_APP_PRIVATE_KEY} is not a valid private key (PEM)`,
		);
	}
	return `${head}.${body}.${b64url(sig)}`;
}

/** `owner/name` of a GitHub repo URL (https or ssh), else null. */
export function repoOf(url: string): { owner: string; name: string } | null {
	const m = url
		.trim()
		.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/**
 * A token for ONE repo (contents + pull requests write), valid one hour:
 * GET /repos/{o}/{r}/installation, then POST
 * /app/installations/{id}/access_tokens. The value is never logged; errors
 * name the fix.
 */
export async function installationToken(o: {
	appId: string | number;
	pem: string;
	repo: string;
	fetch?: Fetch;
	now?: number;
}): Promise<{ token: string; expiresAt: string }> {
	const f = o.fetch ?? fetch;
	const r = repoOf(o.repo);
	if (!r) throw new GitHubError(`not a GitHub repo: ${o.repo}`);
	const auth = {
		...ghHeaders(),
		authorization: `Bearer ${appJwt(o.appId, o.pem, o.now)}`,
	};
	const inst = await f(`${API}/repos/${r.owner}/${r.name}/installation`, {
		headers: auth,
	});
	if (inst.status === 404)
		throw new GitHubError(
			`the GitHub App is not installed on ${r.owner}/${r.name}; install it: mastermind-runner onboard prints the link (github.com/apps/<slug>/installations/new)`,
		);
	if (!inst.ok)
		throw new GitHubError(
			`GitHub App: installation lookup failed (${inst.status}): ${await short(inst)}`,
		);
	const id = ((await inst.json()) as { id?: number }).id;
	if (typeof id !== "number")
		throw new GitHubError("GitHub App: the installation has no id");
	const res = await f(`${API}/app/installations/${id}/access_tokens`, {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({
			repositories: [r.name],
			permissions: { contents: "write", pull_requests: "write" },
		}),
	});
	if (!res.ok)
		throw new GitHubError(
			`GitHub App: token for ${r.owner}/${r.name} refused (${res.status}): ${await short(res)}`,
		);
	const v = (await res.json()) as { token?: string; expires_at?: string };
	if (!v.token) throw new GitHubError("GitHub App: the answer has no token");
	return { token: v.token, expiresAt: String(v.expires_at ?? "") };
}

/** GET /app with the JWT: the app's slug (checks the id and key fit). */
export async function checkApp(
	appId: string | number,
	pem: string,
	f: Fetch = fetch,
): Promise<{ slug: string }> {
	const res = await f(`${API}/app`, {
		headers: { ...ghHeaders(), authorization: `Bearer ${appJwt(appId, pem)}` },
	});
	if (!res.ok)
		throw new GitHubError(
			`GitHub does not accept the app id and key (${res.status}): ${await short(res)}`,
		);
	return { slug: String(((await res.json()) as { slug?: string }).slug ?? "") };
}

/** Who a commit is by: `user.name` and `user.email`. */
export type GitIdentity = { name: string; email: string };

const botIds = new Map<string, GitIdentity>();

/**
 * The commit identity of the App's bot user (mm-210.87), as GitHub Actions
 * commits as `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`:
 * `<slug>[bot] <id+<slug>[bot]@users.noreply.github.com>`. The id links the
 * commit to the bot on GitHub. Slug: `slug` (GITHUB_APP_SLUG), else GET /app.
 * The id: GET /users/<slug>[bot] (with `token`), kept per slug; without it the
 * email has no id. Null: the slug is unknown (the caller keeps its identity).
 */
export async function appBotIdentity(o: {
	appId: string | number;
	pem: string;
	slug?: string;
	token?: string;
	fetch?: Fetch;
}): Promise<GitIdentity | null> {
	const f = o.fetch ?? fetch;
	let slug = o.slug;
	if (!slug)
		try {
			slug = (await checkApp(o.appId, o.pem, f)).slug;
		} catch {
			return null;
		}
	if (!slug) return null;
	const login = `${slug}[bot]`;
	const known = botIds.get(login);
	if (known) return known;
	try {
		const res = await f(`${API}/users/${encodeURIComponent(login)}`, {
			headers: {
				...ghHeaders(),
				...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
			},
		});
		const id = res.ok ? ((await res.json()) as { id?: unknown }).id : null;
		if (typeof id === "number") {
			const who = {
				name: login,
				email: `${id}+${login}@users.noreply.github.com`,
			};
			botIds.set(login, who);
			return who;
		}
	} catch {}
	return { name: login, email: `${login}@users.noreply.github.com` };
}

/** GET /app/installations with the JWT: where the app is installed (account logins). */
export async function appInstallations(
	appId: string | number,
	pem: string,
	f: Fetch = fetch,
): Promise<string[]> {
	const res = await f(`${API}/app/installations`, {
		headers: { ...ghHeaders(), authorization: `Bearer ${appJwt(appId, pem)}` },
	});
	if (!res.ok)
		throw new GitHubError(
			`GitHub App: installations lookup failed (${res.status}): ${await short(res)}`,
		);
	const v = (await res.json()) as { account?: { login?: string } }[];
	return Array.isArray(v) ? v.map((i) => String(i.account?.login ?? "?")) : [];
}

/** GET /user with a token: the login (checks the token is alive). */
export async function checkToken(
	token: string,
	f: Fetch = fetch,
): Promise<{ login: string }> {
	const res = await f(`${API}/user`, {
		headers: { ...ghHeaders(), authorization: `Bearer ${token}` },
	});
	if (!res.ok)
		throw new GitHubError(
			`GitHub does not accept the token (${res.status}); make a new one at ${FINE_GRAINED_URL}`,
		);
	return {
		login: String(((await res.json()) as { login?: string }).login ?? ""),
	};
}

function ghHeaders(): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "mastermind-runner",
	};
}

/** A short, safe part of an error body (GitHub's message only). */
async function short(res: Response): Promise<string> {
	try {
		const v = (await res.json()) as { message?: string };
		return String(v.message ?? "").slice(0, 200) || res.statusText;
	} catch {
		return res.statusText;
	}
}
