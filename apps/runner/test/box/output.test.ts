// Box output against real git: a local bare repo is the "git host" (the
// runner's push reaches it through url.insteadOf); the GitHub REST API is a
// fake fetch.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostRun, hostRun } from "../../src/box/devcontainer.ts";
import type { ExecResult } from "../../src/box/driver.ts";
import {
	appToken,
	CLONE_CRED_DIR,
	cloneCredential,
	deliverOutput,
	githubRepo,
	OutputError,
	type OutputInput,
	outputBranch,
	redact,
	splitGitSecrets,
} from "../../src/box/output.ts";

// Real git, many processes per test: slow on a busy machine.
setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "mm-output-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "ghp_secret_token_value";
const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

function sh(cwd: string, cmd: string[]): ExecResult {
	const p = Bun.spawnSync(cmd, {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: root, ...GIT_ENV },
	});
	return {
		code: p.exitCode ?? 1,
		stdout: p.stdout.toString(),
		stderr: p.stderr.toString(),
	};
}
function must(cwd: string, cmd: string[]): string {
	const r = sh(cwd, cmd);
	if (r.code !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

let n = 0;
/** A bare "host" repo with one commit on main. */
function host(): string {
	const seed = join(root, `seed${++n}`);
	const bare = join(root, `host${n}.git`);
	mkdirSync(seed);
	must(seed, ["git", "init", "-q", "-b", "main"]);
	writeFileSync(join(seed, "a.txt"), "a\n");
	must(seed, ["git", "add", "-A"]);
	must(seed, ["git", "commit", "-q", "-m", "seed"]);
	must(root, ["git", "clone", "-q", "--bare", seed, bare]);
	return bare;
}
const bareOf = new Map<string, string>();
/** The box checkout: the same steps as run.ts. Returns dir and base sha. */
function checkout(bare: string): { dir: string; base: string } {
	const dir = join(root, `box${++n}`);
	mkdirSync(dir);
	must(dir, [
		"sh",
		"-c",
		'git init -q . && git remote add origin "$1" && git fetch -q --depth 1 origin "$2" && git checkout -q FETCH_HEAD',
		"clone",
		bare,
		"main",
	]);
	bareOf.set(dir, bare);
	return { dir, base: must(dir, ["git", "rev-parse", "HEAD"]).trim() };
}

type Call = { method: string; url: string; body?: unknown; auth?: string };
function github(open: { html_url: string }[] = []) {
	const calls: Call[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		const method = init.method ?? "GET";
		const headers = init.headers as Record<string, string>;
		calls.push({
			method,
			url,
			...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
			...(headers?.Authorization ? { auth: headers.Authorization } : {}),
		});
		if (method === "GET" && url.includes("/pulls")) return Response.json(open);
		if (method === "GET") return Response.json({ default_branch: "trunk" });
		return Response.json(
			{ html_url: "https://github.com/acme/web/pull/7" },
			{ status: 201 },
		);
	}) as unknown as typeof fetch;
	return { calls, fetch: f };
}

const REPO = "https://github.com/acme/web.git";
/** Git on the "runner machine": the repo URL leads to the bare host repo. */
function hostTo(bare: string, repo = REPO): HostRun {
	return (cmd, o = {}) => {
		const env = { ...o.env };
		const k = Number(env.GIT_CONFIG_COUNT ?? 0);
		env.GIT_CONFIG_COUNT = String(k + 1);
		env[`GIT_CONFIG_KEY_${k}`] = `url.${bare}.insteadOf`;
		env[`GIT_CONFIG_VALUE_${k}`] = repo;
		return hostRun(cmd, { ...o, env });
	};
}
/** The box: commands run in `dir`; the bundle path is mapped into it. */
const BOX_BUNDLE = "/tmp/mastermind-out.bundle";
function input(
	dir: string,
	base: string,
	over: Partial<OutputInput> = {},
): OutputInput {
	const mapped = join(dir, ".git", "out.bundle");
	const bare = bareOf.get(dir);
	return {
		exec: async (cmd) =>
			sh(
				dir,
				cmd.map((a) => (a === BOX_BUNDLE ? mapped : a)),
			),
		takeOut: async (path) => {
			expect(path).toBe(BOX_BUNDLE);
			return new Uint8Array(readFileSync(mapped));
		},
		...(bare ? { host: hostTo(bare, over.repo) } : {}),
		itemId: "mm-1",
		title: "mm-1: fix the bug",
		output: { kind: "pr" },
		repo: REPO,
		ref: "main",
		baseSha: base,
		secrets: { GITHUB_TOKEN: TOKEN },
		...over,
	};
}
const branchSha = (bare: string, b: string) =>
	sh(bare, ["git", "rev-parse", "--verify", "-q", `refs/heads/${b}`]);

describe("deliverOutput", () => {
	test("output none (or absent): nothing happens", async () => {
		const exec = async (): Promise<ExecResult> => {
			throw new Error("no command expected");
		};
		const i = input("/nope", "x", { exec });
		expect(await deliverOutput({ ...i, output: { kind: "none" } })).toBeNull();
		expect(await deliverOutput({ ...i, output: undefined })).toBeNull();
	});

	test("no changes: says so, pushes nothing, calls no API", async () => {
		const bare = host();
		const { dir, base } = checkout(bare);
		const gh = github();
		const r = await deliverOutput(input(dir, base, { fetch: gh.fetch }));
		expect(r).toEqual({
			kind: "pr",
			commits: 0,
			filesChanged: 0,
			line: "no changes: nothing pushed",
		});
		expect(branchSha(bare, "mm/mm-1").code).not.toBe(0);
		expect(gh.calls).toEqual([]);
	});

	test("pr: commits what is left, pushes mm/<item>, opens a pull request", async () => {
		const bare = host();
		const { dir, base } = checkout(bare);
		writeFileSync(join(dir, "a.txt"), "fixed\n");
		writeFileSync(join(dir, "b.txt"), "new\n");
		const gh = github();
		const r = await deliverOutput(
			input(dir, base, { fetch: gh.fetch, githubApi: "https://api.test" }),
		);
		expect(r).toEqual({
			kind: "pr",
			branch: "mm/mm-1",
			commits: 1,
			filesChanged: 2,
			prUrl: "https://github.com/acme/web/pull/7",
			line: "pull request opened: https://github.com/acme/web/pull/7 (branch mm/mm-1 (1 commit, 2 files) into main)",
		});
		// the branch on the host is the checkout's HEAD, with the item's message
		expect(branchSha(bare, "mm/mm-1").stdout).toBe(
			must(dir, ["git", "rev-parse", "HEAD"]),
		);
		expect(
			must(bare, ["git", "log", "-1", "--format=%B", "mm/mm-1"]),
		).toContain("Mastermind item mm-1");
		expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://api.test/repos/acme/web/pulls?state=open&head=acme%3Amm%2Fmm-1",
			"POST https://api.test/repos/acme/web/pulls",
		]);
		expect(gh.calls[1]?.body).toMatchObject({
			title: "mm-1: fix the bug",
			head: "mm/mm-1",
			base: "main",
		});
		expect(gh.calls[1]?.auth).toBe(`Bearer ${TOKEN}`);
	});

	test("a retry force-pushes the same branch and finds the open pull request", async () => {
		const bare = host();
		const first = checkout(bare);
		writeFileSync(join(first.dir, "a.txt"), "try 1\n");
		await deliverOutput(
			input(first.dir, first.base, { fetch: github().fetch }),
		);

		const again = checkout(bare);
		writeFileSync(join(again.dir, "c.txt"), "try 2\n");
		must(again.dir, ["git", "add", "-A"]);
		must(again.dir, ["git", "commit", "-q", "-m", "agent commit"]);
		const gh = github([{ html_url: "https://github.com/acme/web/pull/7" }]);
		const r = await deliverOutput(
			input(again.dir, again.base, { fetch: gh.fetch }),
		);
		expect(r?.line).toBe(
			"pull request updated: https://github.com/acme/web/pull/7 (branch mm/mm-1 (1 commit, 1 file))",
		);
		expect(branchSha(bare, "mm/mm-1").stdout).toBe(
			must(again.dir, ["git", "rev-parse", "HEAD"]),
		);
		expect(gh.calls.map((c) => c.method)).toEqual(["GET"]);
	});

	test("base: output.base wins; a commit ref asks GitHub for the default branch", async () => {
		const bare = host();
		const a = checkout(bare);
		writeFileSync(join(a.dir, "x"), "1");
		const gh = github();
		await deliverOutput(
			input(a.dir, a.base, {
				fetch: gh.fetch,
				output: { kind: "pr", base: "dev" },
			}),
		);
		expect(gh.calls[1]?.body).toMatchObject({ base: "dev" });

		const b = checkout(bare);
		writeFileSync(join(b.dir, "y"), "1");
		const gh2 = github();
		await deliverOutput(
			input(b.dir, b.base, { fetch: gh2.fetch, ref: b.base }),
		);
		expect(gh2.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
		expect(gh2.calls[2]?.body).toMatchObject({ base: "trunk" });
	});

	test("branch: push only; another host: push only and say so", async () => {
		const bare = host();
		const a = checkout(bare);
		writeFileSync(join(a.dir, "x"), "1");
		const gh = github();
		const r = await deliverOutput(
			input(a.dir, a.base, { fetch: gh.fetch, output: { kind: "branch" } }),
		);
		expect(r?.line).toBe("pushed branch mm/mm-1 (1 commit, 1 file)");
		expect(gh.calls).toEqual([]);

		const b = checkout(bare);
		writeFileSync(join(b.dir, "y"), "1");
		const r2 = await deliverOutput(
			input(b.dir, b.base, {
				fetch: gh.fetch,
				repo: "git@gitlab.example.com:acme/web.git",
			}),
		);
		expect(r2?.line).toBe(
			"pushed branch mm/mm-1 (1 commit, 1 file); no pull request: gitlab.example.com is not GitHub, open it by hand",
		);
		expect(r2?.prUrl).toBeUndefined();
		expect(gh.calls).toEqual([]);
	});

	test("a failing push or API call is an OutputError with no secret value", async () => {
		const bare = host();
		const a = checkout(bare);
		writeFileSync(join(a.dir, "x"), "1");
		// the host refuses the push and echoes the token
		const hook = join(bare, "hooks", "pre-receive");
		writeFileSync(hook, `#!/bin/sh\necho "denied ${TOKEN}" >&2\nexit 1\n`, {
			mode: 0o755,
		});
		const err = await deliverOutput(input(a.dir, a.base)).catch((e) => e);
		expect(err).toBeInstanceOf(OutputError);
		expect(err.message).toContain("git push mm/mm-1");
		expect(err.message).toContain("denied ***");
		expect(err.message).not.toContain(TOKEN);
		rmSync(hook);

		const b = checkout(bare);
		writeFileSync(join(b.dir, "y"), "1");
		const bad = (async () =>
			new Response(`bad credentials ${TOKEN}`, {
				status: 401,
			})) as unknown as typeof fetch;
		const err2 = await deliverOutput(
			input(b.dir, b.base, { fetch: bad }),
		).catch((e) => e);
		expect(err2).toBeInstanceOf(OutputError);
		expect(err2.message).toContain("401 bad credentials ***");
	});
});

describe("the push runs on the runner machine", () => {
	test("only mm/<item> on the host: the agent's git config, hooks and branches in the box do nothing", async () => {
		const bare = host();
		const other = host();
		const { dir, base } = checkout(bare);
		const main = must(bare, ["git", "rev-parse", "main"]);
		// the agent: a commit, a push URL elsewhere, a pre-push hook, a moved main
		writeFileSync(join(dir, "a.txt"), "agent\n");
		must(dir, ["git", "commit", "-qam", "agent"]);
		must(dir, ["git", "config", "remote.origin.pushurl", other]);
		must(dir, ["git", "config", "credential.helper", "!echo stolen >&2; f"]);
		writeFileSync(
			join(dir, ".git/hooks/pre-push"),
			"#!/bin/sh\ntouch /tmp/x\n",
			{
				mode: 0o755,
			},
		);
		must(dir, ["git", "branch", "-f", "main", "HEAD"]);
		const r = await deliverOutput(
			input(dir, base, { output: { kind: "branch" } }),
		);
		expect(r?.line).toBe("pushed branch mm/mm-1 (1 commit, 1 file)");
		expect(branchSha(bare, "mm/mm-1").stdout).toBe(
			must(dir, ["git", "rev-parse", "HEAD"]),
		);
		expect(must(bare, ["git", "rev-parse", "main"])).toBe(main);
		expect(
			must(bare, ["git", "for-each-ref", "--format=%(refname)"]).trim(),
		).toBe("refs/heads/main\nrefs/heads/mm/mm-1");
		expect(branchSha(other, "mm/mm-1").code).not.toBe(0);
	});

	test("the base comes from the host even when the ref moved since the clone", async () => {
		const bare = host();
		const { dir, base } = checkout(bare);
		// main moves on the host after the clone
		const seed = join(root, `move${++n}`);
		must(root, ["git", "clone", "-q", bare, seed]);
		writeFileSync(join(seed, "z"), "z");
		must(seed, ["git", "add", "-A"]);
		must(seed, ["git", "commit", "-qm", "moved"]);
		must(seed, ["git", "push", "-q", "origin", "main"]);
		writeFileSync(join(dir, "y"), "1");
		const r = await deliverOutput(
			input(dir, base, { output: { kind: "branch" } }),
		);
		expect(r?.line).toBe("pushed branch mm/mm-1 (1 commit, 1 file)");
		expect(must(bare, ["git", "rev-parse", "mm/mm-1~1"]).trim()).toBe(base);
	});
});

describe("git credential: split and clone", () => {
	test("splitGitSecrets: the git credential secrets stay out of the box set", () => {
		expect(
			splitGitSecrets({
				GITHUB_TOKEN: "t",
				GH_TOKEN: "u",
				GIT_TOKEN: "v",
				GIT_SSH_KEY: "k",
				GITHUB_APP_PRIVATE_KEY: "p",
				CLAUDE_CODE_OAUTH_TOKEN: "c",
				"deploy.key": "d",
			}),
		).toEqual({
			git: {
				GITHUB_TOKEN: "t",
				GH_TOKEN: "u",
				GIT_TOKEN: "v",
				GIT_SSH_KEY: "k",
				GITHUB_APP_PRIVATE_KEY: "p",
			},
			box: { CLAUDE_CODE_OAUTH_TOKEN: "c", "deploy.key": "d" },
		});
	});

	test("cloneCredential: git gets the token from the command's env; nothing in .git/config", () => {
		const c = cloneCredential({ GH_TOKEN: "", GITHUB_TOKEN: TOKEN });
		expect(c.script).toBe("");
		expect(c.key).toBeUndefined();
		const dir = join(root, `cred${++n}`);
		mkdirSync(dir);
		must(dir, ["git", "init", "-q", "."]);
		const fill = Bun.spawnSync(["git", "credential", "fill"], {
			cwd: dir,
			stdin: Buffer.from("protocol=https\nhost=github.com\n\n"),
			env: { PATH: process.env.PATH ?? "", HOME: root, ...GIT_ENV, ...c.env },
		});
		expect(fill.stdout.toString()).toContain(
			`username=x-access-token\npassword=${TOKEN}\n`,
		);
		expect(readFileSync(join(dir, ".git/config"), "utf8")).not.toContain(TOKEN);
		// without the command's env, git has no credential
		const none = Bun.spawnSync(["git", "credential", "fill"], {
			cwd: dir,
			stdin: Buffer.from("protocol=https\nhost=github.com\n\n"),
			env: { PATH: process.env.PATH ?? "", HOME: root, ...GIT_ENV },
		});
		expect(none.stdout.toString()).not.toContain(TOKEN);
	});

	test("cloneCredential: a deploy key is a file in CLONE_CRED_DIR, used through GIT_SSH_COMMAND", () => {
		const c = cloneCredential({ GIT_SSH_KEY: "KEY" });
		expect(c.key).toBe("KEY\n");
		expect(c.script).toContain(
			`cp ${CLONE_CRED_DIR}/key.in ${CLONE_CRED_DIR}/key`,
		);
		expect(c.env.GIT_SSH_COMMAND).toContain(`-i ${CLONE_CRED_DIR}/key`);
		expect(c.env.MM_GIT_TOKEN).toBeUndefined();
	});

	test("no git secret: nothing to set", () => {
		expect(cloneCredential({})).toEqual({
			env: { GIT_TERMINAL_PROMPT: "0" },
			script: "",
		});
	});
});

describe("helpers", () => {
	test("githubRepo", () => {
		for (const u of [
			"https://github.com/acme/web.git",
			"https://github.com/acme/web",
			"https://x-access-token@github.com/acme/web.git",
			"git@github.com:acme/web.git",
			"ssh://git@github.com/acme/web.git",
		])
			expect(githubRepo(u)).toEqual({ owner: "acme", repo: "web" });
		expect(githubRepo("https://gitlab.com/acme/web.git")).toBeNull();
		expect(githubRepo("https://github.com.evil.io/acme/web")).toBeNull();
	});

	test("outputBranch and redact", () => {
		expect(outputBranch("mm-210.53")).toBe("mm/mm-210.53");
		expect(outputBranch("a b/c")).toBe("mm/a-b-c");
		expect(redact("x abcd y abcd", { A: "abcd", B: "" })).toBe("x *** y ***");
	});
});

describe("appToken (mm-210.69)", () => {
	test("null without both app secrets or for a repo not on github.com: no API call", async () => {
		let calls = 0;
		const fetch = (async () => {
			calls++;
			return Response.json({});
		}) as unknown as typeof globalThis.fetch;
		const repo = "https://github.com/acme/web.git";
		expect(await appToken({ GIT_TOKEN: "t" }, repo, { fetch })).toBeNull();
		expect(await appToken({ GITHUB_APP_ID: "1" }, repo, { fetch })).toBeNull();
		expect(
			await appToken(
				{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" },
				"https://gitlab.com/acme/web.git",
				{ fetch },
			),
		).toBeNull();
		expect(calls).toBe(0);
	});

	test("the token replaces GIT_TOKEN; the app secrets are dropped; the rest is kept", async () => {
		const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ type: "pkcs1", format: "pem" })
			.toString();
		const fetch = (async (url: string) =>
			url.endsWith("/installation")
				? Response.json({ id: 5 })
				: Response.json({
						token: "ghs_new",
						expires_at: "2026-11-12T11:00:00Z",
					})) as unknown as typeof globalThis.fetch;
		const got = await appToken(
			{
				GITHUB_APP_ID: "1",
				GITHUB_APP_PRIVATE_KEY: pem,
				GITHUB_APP_SLUG: "s",
				GIT_TOKEN: "old",
				GIT_SSH_KEY: "key",
			},
			"git@github.com:acme/web.git",
			{ fetch },
		);
		expect(got).toEqual({
			secrets: { GIT_TOKEN: "ghs_new", GIT_SSH_KEY: "key" },
			expiresAt: Date.parse("2026-11-12T11:00:00Z"),
			repo: "acme/web",
		});
	});
});
