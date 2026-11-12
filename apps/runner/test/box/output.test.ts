// Box output against real git: a local bare repo is the "git host"; the GitHub
// REST API is a fake fetch.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../../src/box/driver.ts";
import {
	deliverOutput,
	gitCredentialScript,
	githubRepo,
	OutputError,
	type OutputInput,
	outputBranch,
	redact,
} from "../../src/box/output.ts";

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

function input(
	dir: string,
	base: string,
	over: Partial<OutputInput> = {},
): OutputInput {
	return {
		exec: async (cmd) => sh(dir, cmd),
		itemId: "mm-1",
		title: "mm-1: fix the bug",
		output: { kind: "pr" },
		repo: "https://github.com/acme/web.git",
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
		must(a.dir, [
			"git",
			"remote",
			"set-url",
			"origin",
			join(root, `gone-${TOKEN}`),
		]);
		const err = await deliverOutput(input(a.dir, a.base)).catch((e) => e);
		expect(err).toBeInstanceOf(OutputError);
		expect(err.message).toContain("git push mm/mm-1");
		expect(err.message).not.toContain(TOKEN);

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

describe("gitCredentialScript", () => {
	test("git gets the token from the file when it asks; no value in .git/config", () => {
		const secrets = join(root, "secrets");
		mkdirSync(secrets, { recursive: true });
		writeFileSync(join(secrets, "GITHUB_TOKEN"), TOKEN);
		const dir = join(root, `cred${++n}`);
		mkdirSync(dir);
		must(dir, ["git", "init", "-q", "."]);
		must(dir, [
			"sh",
			"-c",
			gitCredentialScript({ GH_TOKEN: "", GITHUB_TOKEN: TOKEN }, secrets),
		]);
		const fill = Bun.spawnSync(["git", "credential", "fill"], {
			cwd: dir,
			stdin: Buffer.from("protocol=https\nhost=github.com\n\n"),
			env: { PATH: process.env.PATH ?? "", HOME: root, ...GIT_ENV },
		});
		expect(fill.stdout.toString()).toContain(
			`username=x-access-token\npassword=${TOKEN}\n`,
		);
		expect(readFileSync(join(dir, ".git/config"), "utf8")).not.toContain(TOKEN);
	});

	test("a deploy key becomes core.sshCommand with a 0600 copy", () => {
		const secrets = join(root, "secrets2");
		mkdirSync(secrets, { recursive: true });
		writeFileSync(join(secrets, "GIT_SSH_KEY"), "KEY", { mode: 0o444 });
		const dir = join(root, `key${++n}`);
		mkdirSync(dir);
		must(dir, ["git", "init", "-q", "."]);
		must(dir, [
			"sh",
			"-c",
			gitCredentialScript({ GIT_SSH_KEY: "KEY" }, secrets),
		]);
		const cmd = must(dir, ["git", "config", "core.sshCommand"]);
		expect(cmd).toContain(`-i ${dir}/.git/mastermind-git-key`);
		const st = Bun.spawnSync([
			"stat",
			"-c",
			"%a",
			`${dir}/.git/mastermind-git-key`,
		]);
		expect(st.stdout.toString().trim()).toBe("600");
	});

	test("no git secret: nothing to set", () => {
		expect(gitCredentialScript({ CLAUDE_CODE_OAUTH_TOKEN: "x" }, "/s")).toBe(
			"",
		);
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
