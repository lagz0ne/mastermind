import { describe, expect, test } from "bun:test";
import {
	type AccessInput,
	accessStep,
	checkEnvironmentsAccess,
	NO_GIT_CREDENTIAL_FIX,
} from "../src/access.ts";
import type { AccessResult } from "../src/box/devcontainer.ts";
import { fetchNeeds } from "../src/secrets/needs.ts";

const needs = {
	at: "2026-11-12T00:00:00Z",
	environments: [
		{
			name: "web",
			secrets: ["GIT_TOKEN"],
			repo: "https://g/x/web",
			ref: "main",
		},
		{
			name: "api",
			secrets: ["GIT_TOKEN"],
			repo: "https://g/x/api",
			ref: "dev",
		},
		{ name: "locked", secrets: ["KEY"], repo: "https://g/x/l", ref: "main" },
		{ name: "norepo", secrets: [] },
	],
};

const input = (over: Partial<AccessInput> = {}): AccessInput => ({
	needs,
	routing: { environments: {}, implicit: true },
	store: { GIT_TOKEN: "tok-secret" },
	env: {},
	...over,
});

describe("checkEnvironmentsAccess", () => {
	test("one check per environment with a repo and all its secrets", async () => {
		const seen: string[] = [];
		const out = await checkEnvironmentsAccess(
			input({
				check: async (repo, ref, secrets): Promise<AccessResult> => {
					seen.push(`${repo}@${ref}:${secrets.GIT_TOKEN}`);
					return repo.endsWith("api")
						? {
								ok: false,
								kind: "ref-missing",
								reason: "ref dev is not in https://g/x/api",
							}
						: { ok: true };
				},
			}),
		);
		expect(seen.sort()).toEqual([
			"https://g/x/api@dev:tok-secret",
			"https://g/x/web@main:tok-secret",
		]);
		expect(out).toEqual({
			web: { ok: true, repo: "https://g/x/web", ref: "main" },
			api: {
				ok: false,
				repo: "https://g/x/api",
				ref: "dev",
				problem: "ref dev is not in https://g/x/api",
				fix: "push dev to https://g/x/api, or change the environment's ref",
			},
		});
	});

	test("bound environments only; the binding's secret source is used", async () => {
		const out = await checkEnvironmentsAccess(
			input({
				store: {},
				env: { MY_TOKEN: "t2" },
				routing: {
					environments: {
						web: { env: { GIT_TOKEN: "env:MY_TOKEN" } } as never,
					},
					implicit: false,
				},
				check: async (_r, _f, secrets) =>
					secrets.GIT_TOKEN === "t2"
						? { ok: true }
						: { ok: false, kind: "no-access", reason: "no" },
			}),
		);
		expect(Object.keys(out)).toEqual(["web"]);
		expect(out.web?.ok).toBe(true);
	});

	test("a mint failure or a timeout is the reason", async () => {
		const minted = await checkEnvironmentsAccess(
			input({
				mint: async () => {
					throw new Error("the GitHub App is not installed on x/web");
				},
				check: async () => ({ ok: true }),
			}),
		);
		expect(minted.web).toMatchObject({
			ok: false,
			problem:
				"git access to https://g/x/web: the GitHub App is not installed on x/web",
		});
		const slow = await checkEnvironmentsAccess(
			input({
				timeoutMs: 20,
				check: (_r, _f, _s, signal) =>
					new Promise((done) =>
						signal.addEventListener("abort", () =>
							done({ ok: false, kind: "error", reason: "git exited 143" }),
						),
					),
			}),
		);
		expect(slow.web).toMatchObject({
			ok: false,
			problem: "repo https://g/x/web did not answer within 0.02 s",
			fix: "check that this machine reaches https://g/x/web",
		});
	});

	test("GitHub App secrets on a non-GitHub repo: the secrets go as they are", async () => {
		let got: Record<string, string> = {};
		await checkEnvironmentsAccess(
			input({
				needs: {
					at: needs.at,
					environments: [
						{
							name: "lab",
							secrets: ["GIT_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
							repo: "https://gitlab.com/x/lab.git",
							ref: "main",
						},
					],
				},
				store: {
					GIT_TOKEN: "t",
					GITHUB_APP_ID: "1",
					GITHUB_APP_PRIVATE_KEY: "k",
				},
				check: async (_r, _f, secrets) => {
					got = secrets;
					return { ok: true };
				},
			}),
		);
		expect(got).toEqual({
			GIT_TOKEN: "t",
			GITHUB_APP_ID: "1",
			GITHUB_APP_PRIVATE_KEY: "k",
		});
	});

	test("the runner's own GitHub App secrets go to the mint even when the environment does not list them (mm-210.87)", async () => {
		const minted: Record<string, string>[] = [];
		const out = await checkEnvironmentsAccess(
			input({
				needs: {
					at: needs.at,
					environments: [
						{
							name: "scratch",
							secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
							repo: "https://github.com/acme/scratch",
							ref: "main",
						},
					],
				},
				store: {
					CLAUDE_CODE_OAUTH_TOKEN: "oauth",
					GITHUB_APP_ID: "123",
					GITHUB_APP_PRIVATE_KEY: "pem",
				},
				mint: async (secrets) => {
					minted.push(secrets);
					return { GIT_TOKEN: "ghs_1" };
				},
				check: async (_r, _ref, secrets) =>
					secrets.GIT_TOKEN === "ghs_1"
						? { ok: true }
						: { ok: false, kind: "no-access", reason: "no token" },
			}),
		);
		expect(minted).toEqual([
			{
				CLAUDE_CODE_OAUTH_TOKEN: "oauth",
				GITHUB_APP_ID: "123",
				GITHUB_APP_PRIVATE_KEY: "pem",
			},
		]);
		expect(out.scratch?.ok).toBe(true);
	});
	test("output pr or branch without any git credential: not ready, no ls-remote; with one it is checked (mm-210.87)", async () => {
		const scratch = {
			name: "scratch",
			secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
			repo: "https://github.com/acme/scratch",
			ref: "main",
			output: "pr" as const,
		};
		const reads = {
			name: "reads",
			secrets: [],
			repo: "https://github.com/acme/public",
			ref: "main",
		};
		const checked: string[] = [];
		const run = (store: Record<string, string>) =>
			checkEnvironmentsAccess(
				input({
					needs: { at: needs.at, environments: [scratch, reads] },
					store,
					mint: async (s) => s,
					check: async (repo) => {
						checked.push(repo);
						return { ok: true };
					},
				}),
			);
		const none = await run({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
		expect(none.scratch).toEqual({
			ok: false,
			repo: scratch.repo,
			ref: "main",
			problem:
				"output pr pushes a branch to https://github.com/acme/scratch: this runner has no git credential (GitHub App, GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN or GIT_SSH_KEY)",
			fix: NO_GIT_CREDENTIAL_FIX,
		});
		// Output none (no output field): a public repo needs no credential.
		expect(none.reads?.ok).toBe(true);
		expect(checked).toEqual([reads.repo]);
		for (const store of <Record<string, string>[]>[
			{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem" },
			{ GH_TOKEN: "t" },
			{ GIT_SSH_KEY: "k" },
		]) {
			const out = await run({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ...store });
			expect(out.scratch?.ok).toBe(true);
		}
		// The app id alone is no credential.
		const half = await run({
			CLAUDE_CODE_OAUTH_TOKEN: "o",
			GITHUB_APP_ID: "1",
		});
		expect(half.scratch?.ok).toBe(false);
	});
	test("unknown environments: nothing to check", async () => {
		expect(await checkEnvironmentsAccess(input({ needs: null }))).toEqual({});
	});
});

describe("accessStep (onboard)", () => {
	test("every unreadable environment with its fix; else the readable ones", () => {
		expect(accessStep({})).toEqual({
			ok: true,
			detail: "no environment has a repo",
		});
		const ok = { ok: true as const, repo: "https://g/x/web", ref: "main" };
		expect(accessStep({ web: ok })).toEqual({
			ok: true,
			detail: "web: https://g/x/web readable",
		});
		expect(
			accessStep({
				web: ok,
				api: { ...ok, ok: false, problem: "no access", fix: "add GIT_TOKEN" },
			}),
		).toEqual({
			ok: false,
			problem: "api: no access",
			fix: "api: add GIT_TOKEN",
		});
	});
});

test("fetchNeeds keeps repo and ref of an environment that has a repo", async () => {
	const body = {
		environments: [
			{ name: "web", secrets: [], repo: "https://g/x/web", ref: "main" },
			{ name: "plain", secrets: [] },
			{ name: "pr", secrets: [], repo: "https://g/x/pr", output: "pr" },
			{ name: "odd", secrets: [], output: "tarball" },
		],
	};
	const n = await fetchNeeds("https://mm", "c", {
		fetch: (async () => Response.json(body)) as unknown as typeof fetch,
	});
	expect(n.environments).toEqual([
		{ name: "web", secrets: [], repo: "https://g/x/web", ref: "main" },
		{ name: "plain", secrets: [] },
		{ name: "pr", secrets: [], repo: "https://g/x/pr", ref: "", output: "pr" },
		{ name: "odd", secrets: [] },
	]);
});
