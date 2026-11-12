/**
 * GitHub credentials (mm-210.67): the App Manifest flow (loopback page,
 * callback with state, pasted code, code exchange), the app JWT, and the
 * installation token for one repo, against a fake GitHub API.
 */
import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
	APP_PERMISSIONS,
	appJwt,
	appManifest,
	exchangeCode,
	GitHubError,
	installationToken,
	installUrl,
	manifestTarget,
	parseCode,
	repoOf,
	serveManifest,
} from "../src/github.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

type Call = { url: string; method: string; headers: Headers; body?: string };

function fakeGitHub(routes: Record<string, (c: Call) => Response>) {
	const calls: Call[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const c: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		};
		calls.push(c);
		const key = `${c.method} ${new URL(c.url).pathname}`;
		const h = routes[key];
		return h ? h(c) : new Response('{"message":"Not Found"}', { status: 404 });
	}) as typeof fetch;
	return { f, calls };
}

describe("manifest", () => {
	test("asks only for contents + pull requests write, metadata read, no webhook", () => {
		const m = appManifest({
			name: "mm-x",
			redirectUrl: "http://127.0.0.1:1/callback",
		});
		expect(m.default_permissions).toEqual({ ...APP_PERMISSIONS });
		expect(m.default_events).toEqual([]);
		expect(m.public).toBe(false);
		expect((m.hook_attributes as { active: boolean }).active).toBe(false);
	});

	test("target: personal account or an organization", () => {
		expect(manifestTarget("s1")).toBe(
			"https://github.com/settings/apps/new?state=s1",
		);
		expect(manifestTarget("s1", "acme")).toBe(
			"https://github.com/organizations/acme/settings/apps/new?state=s1",
		);
		expect(installUrl("mm-x")).toBe(
			"https://github.com/apps/mm-x/installations/new",
		);
	});

	test("loopback: / posts the manifest; /callback with the right state gives the code", async () => {
		const s = serveManifest({ name: "mm-x", state: "st8" });
		try {
			const page = await (await fetch(s.url)).text();
			expect(page).toContain(
				'action="https://github.com/settings/apps/new?state=st8"',
			);
			expect(page).toContain("&quot;redirect_url&quot;");
			expect(page).toContain(s.redirectUrl);
			const bad = await fetch(`${s.redirectUrl}?code=abc&state=other`);
			expect(bad.status).toBe(400);
			const ok = await fetch(`${s.redirectUrl}?code=abc&state=st8`);
			expect(ok.status).toBe(200);
			expect(await s.code).toBe("abc");
		} finally {
			s.stop();
		}
	});

	test("a pasted callback URL or bare code", () => {
		expect(
			parseCode("http://127.0.0.1:9/callback?code=c1&state=s", "s"),
		).toEqual({
			code: "c1",
		});
		expect("error" in parseCode("http://x/callback?code=c1&state=t", "s")).toBe(
			true,
		);
		expect(parseCode(" c2 ")).toEqual({ code: "c2" });
		expect("error" in parseCode("a b")).toBe(true);
	});

	test("exchange: app id, slug, key", async () => {
		const gh = fakeGitHub({
			"POST /app-manifests/c1/conversions": () =>
				Response.json({
					id: 42,
					slug: "mm-x",
					pem: privateKey,
					owner: { login: "duke" },
					html_url: "https://github.com/apps/mm-x",
					client_secret: "not kept",
				}),
		});
		const app = await exchangeCode("c1", gh.f);
		expect(app).toEqual({
			id: 42,
			slug: "mm-x",
			pem: privateKey,
			owner: "duke",
			htmlUrl: "https://github.com/apps/mm-x",
		});
		await expect(exchangeCode("old", gh.f)).rejects.toThrow(/one hour/);
	});
});

describe("installation token", () => {
	test("the JWT is RS256 signed by the app key, iss = app id", () => {
		const jwt = appJwt(42, privateKey, 1_700_000_000_000);
		const [h, b, sig] = jwt.split(".") as [string, string, string];
		const body = JSON.parse(Buffer.from(b, "base64url").toString());
		expect(body).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "42" });
		const ok = createVerify("RSA-SHA256")
			.update(`${h}.${b}`)
			.verify(publicKey, Buffer.from(sig, "base64url"));
		expect(ok).toBe(true);
		expect(() => appJwt(42, "not a key")).toThrow(GitHubError);
	});

	test("repo URLs", () => {
		expect(repoOf("https://github.com/acme/web.git")).toEqual({
			owner: "acme",
			name: "web",
		});
		expect(repoOf("git@github.com:acme/web.git")).toEqual({
			owner: "acme",
			name: "web",
		});
		expect(repoOf("https://gitlab.com/acme/web")).toBeNull();
	});

	test("one repo, contents + pull requests write", async () => {
		const gh = fakeGitHub({
			"GET /repos/acme/web/installation": () => Response.json({ id: 7 }),
			"POST /app/installations/7/access_tokens": () =>
				Response.json({ token: "ghs_x", expires_at: "2026-11-12T13:00:00Z" }),
		});
		const t = await installationToken({
			appId: 42,
			pem: privateKey,
			repo: "https://github.com/acme/web",
			fetch: gh.f,
		});
		expect(t).toEqual({ token: "ghs_x", expiresAt: "2026-11-12T13:00:00Z" });
		const post = gh.calls[1];
		expect(JSON.parse(post?.body ?? "")).toEqual({
			repositories: ["web"],
			permissions: { contents: "write", pull_requests: "write" },
		});
		expect(post?.headers.get("authorization")).toMatch(/^Bearer ey/);
	});

	test("not installed: says how to install", async () => {
		const gh = fakeGitHub({});
		await expect(
			installationToken({
				appId: 42,
				pem: privateKey,
				repo: "https://github.com/acme/web",
				fetch: gh.f,
			}),
		).rejects.toThrow(/not installed on acme\/web/);
	});
});
