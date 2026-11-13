/**
 * How code leaves the box (human decision C, 2026-11-11): through the git host.
 *
 *   agent done -> commit what is left (in the box) -> nothing changed? say so,
 *   push nothing -> a git bundle of the new commits out of the box
 *   -> on THIS machine: fetch the base, take the bundle, push branch mm/<item>
 *      (force: a retry starts again from the base)
 *   -> output pr on GitHub: open a pull request against the base, or find the
 *      open one of an earlier try (the push updated it)
 *
 * The git credential stays out of the agent's reach (mm-210.64; prior art:
 * the Copilot coding agent cannot run git push, Codex removes secrets before
 * the agent phase): the credential secrets (GIT_TOKEN, GITHUB_TOKEN or
 * GH_TOKEN; or GIT_SSH_KEY, a deploy key) are never box env or files in the
 * secrets directory. The clone gets them in the env of that one command
 * ({@link cloneCredential}); the push runs on the runner machine, to the one
 * ref refs/heads/mm/<item>, from a fresh repo the agent never touched.
 * Other git hosts: the branch is pushed, the pull request is opened by hand.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentOutput } from "@mastermind/core";
import {
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	type GitIdentity,
	installationToken,
} from "../github.ts";
import { gitEnv, type HostRun, hostRun } from "./devcontainer.ts";
import type { ExecResult } from "./driver.ts";

/** Secret names a token for `git push` and the GitHub API is read from, in order. */
export const GIT_TOKEN_SECRETS = ["GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
/** Secret name of an SSH deploy key (never a file the agent can read). */
export const GIT_SSH_KEY_SECRET = "GIT_SSH_KEY";
/** The runner owner's GitHub App (mm-210.67): its key mints installation tokens. */
export const GITHUB_APP_SECRETS = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_SLUG",
];
/** The git credential secrets: held by the runner, never in the box for the agent. */
export const GIT_CREDENTIAL_SECRETS = [
	...GIT_TOKEN_SECRETS,
	GIT_SSH_KEY_SECRET,
	...GITHUB_APP_SECRETS,
];
/** Where the deploy key is for the clone only; deleted before anything else runs. */
export const CLONE_CRED_DIR = "/run/mastermind/clone-credential";
/**
 * Who the commits are by when the runner has no GitHub App: never a person
 * (the agent once took a human's name from the repo's history: mm-210.87).
 */
export const MASTERMIND_IDENTITY: GitIdentity = {
	name: "Mastermind",
	email: "mastermind@users.noreply.github.com",
};

/** Git's author and committer env for `id` (wins over any git config). */
export function identityEnv(id: GitIdentity): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: id.name,
		GIT_AUTHOR_EMAIL: id.email,
		GIT_COMMITTER_NAME: id.name,
		GIT_COMMITTER_EMAIL: id.email,
	};
}

/** The bundle of the new commits, in the box. */
const BUNDLE = "/tmp/mastermind-out.bundle";

export type OutputResult = {
	kind: "pr" | "branch";
	/** Branch on the git host; absent when nothing was pushed. */
	branch?: string;
	/** Commits on top of the base. */
	commits: number;
	filesChanged: number;
	prUrl?: string;
	/** One line for the ticket. */
	line: string;
};

export type OutputInput = {
	/** Runs a command in the checkout of the box (no credential there). */
	exec: (cmd: string[]) => Promise<ExecResult>;
	/** The bytes of one file of the box. */
	takeOut: (path: string) => Promise<Uint8Array>;
	/** Git on this machine (the push); default: spawn. */
	host?: HostRun;
	itemId: string;
	/** The item's title: commit message and pull request title. */
	title: string;
	output: EnvironmentOutput | undefined;
	/** Git remote URL (origin in the box). */
	repo: string;
	/** The ref that was checked out. */
	ref: string;
	/** The commit that was checked out. */
	baseSha: string;
	/** The git credential secrets ({@link splitGitSecrets}), by name. */
	secrets: Record<string, string>;
	/** Who the commit is by; default {@link MASTERMIND_IDENTITY}. */
	author?: GitIdentity;
	fetch?: typeof fetch;
	/** GitHub REST API base; default https://api.github.com. */
	githubApi?: string;
	signal?: AbortSignal;
};

export class OutputError extends Error {
	override name = "OutputError";
}

/** The branch of an item: `mm/<item id>`. */
export function outputBranch(itemId: string): string {
	return `mm/${itemId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/** `{owner, repo}` when the remote is on github.com; else null. */
export function githubRepo(
	url: string,
): { owner: string; repo: string } | null {
	const m =
		/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
			url.trim(),
		);
	return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/** The host of a git remote URL, for the "push only" line. */
function hostOf(url: string): string {
	return (
		/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1] ??
		/^[^@/:]+@([^:]+):/.exec(url)?.[1] ??
		url
	);
}

/** Replace every secret value in a message (git and API errors can echo input). */
export function redact(text: string, secrets: Record<string, string>): string {
	let out = text;
	for (const v of Object.values(secrets))
		if (v.length >= 4) out = out.split(v).join("***");
	return out;
}

function tail(r: ExecResult, n = 500): string {
	return `${r.stdout}${r.stderr}`.trim().slice(-n);
}

/** The token secret for git and the GitHub API: the first of {@link GIT_TOKEN_SECRETS} given. */
export function gitTokenName(
	secrets: Record<string, string>,
): string | undefined {
	return GIT_TOKEN_SECRETS.find((n) => secrets[n]);
}

/**
 * Split resolved secrets: `git` (the credential secrets, kept on the runner
 * machine) and `box` (the rest: box env and files for the agent).
 */
export function splitGitSecrets(secrets: Record<string, string>): {
	git: Record<string, string>;
	box: Record<string, string>;
} {
	const git: Record<string, string> = {};
	const box: Record<string, string> = {};
	for (const [k, v] of Object.entries(secrets))
		(GIT_CREDENTIAL_SECRETS.includes(k) ? git : box)[k] = v;
	return { git, box };
}

/** Mint the app token again when it has less than this left (before the push). */
export const APP_TOKEN_MIN_LEFT_MS = 10 * 60_000;

export type AppToken = {
	/** The secrets with GIT_TOKEN = the installation token; no app secrets. */
	secrets: Record<string, string>;
	/** When the token ends (epoch ms). */
	expiresAt: number;
	/** `owner/name` it is for. */
	repo: string;
};

/**
 * The GitHub App way (mm-210.69): when `secrets` have GITHUB_APP_ID and
 * GITHUB_APP_PRIVATE_KEY and `repo` is on github.com, mint an installation
 * token for that ONE repo (contents + pull requests write, 1 h) and use it as
 * GIT_TOKEN for the access check, the clone, the push and the PR API. The app
 * key stays in this process: the returned secrets do not hold it. Null: no
 * app (or not GitHub), the GIT_TOKEN / GITHUB_TOKEN / GIT_SSH_KEY way is
 * unchanged. Throws GitHubError with the fix (never a secret value).
 */
export async function appToken(
	secrets: Record<string, string>,
	repo: string,
	o: { fetch?: typeof fetch; now?: number } = {},
): Promise<AppToken | null> {
	const appId = secrets[GITHUB_APP_ID];
	const pem = secrets[GITHUB_APP_PRIVATE_KEY];
	const gh = githubRepo(repo);
	if (!appId || !pem || !gh) return null;
	const now = o.now ?? Date.now();
	const t = await installationToken({
		appId,
		pem,
		repo,
		now,
		...(o.fetch ? { fetch: o.fetch } : {}),
	});
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(secrets))
		if (!GITHUB_APP_SECRETS.includes(k)) out[k] = v;
	out.GIT_TOKEN = t.token;
	return {
		secrets: out,
		expiresAt: Date.parse(t.expiresAt) || now + 60 * 60_000,
		repo: `${gh.owner}/${gh.repo}`,
	};
}

/**
 * The credential for the ONE clone command in the box: values only in that
 * command's env (`env`), the credential helper through GIT_CONFIG_* env (never
 * in .git/config, argv or a URL). A deploy key: put `key` into
 * {@link CLONE_CRED_DIR} first; `script` (run before the fetch) makes a 0600
 * copy, as ssh refuses a key others can read. Delete CLONE_CRED_DIR after.
 */
export function cloneCredential(git: Record<string, string>): {
	env: Record<string, string>;
	script: string;
	key?: string;
} {
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
	let script = "";
	const name = gitTokenName(git);
	const token = name ? git[name] : undefined;
	if (token) {
		env.MM_GIT_TOKEN = token;
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = "credential.helper";
		env.GIT_CONFIG_VALUE_0 =
			'!f() { test "$1" = get || exit 0; echo username=x-access-token; printf "password=%s\\n" "$MM_GIT_TOKEN"; }; f';
	}
	const key = git[GIT_SSH_KEY_SECRET];
	if (key) {
		script = `(umask 077 && cp ${CLONE_CRED_DIR}/key.in ${CLONE_CRED_DIR}/key)`;
		env.GIT_SSH_COMMAND = `ssh -i ${CLONE_CRED_DIR}/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
	}
	return {
		env,
		script,
		...(key ? { key: key.endsWith("\n") ? key : `${key}\n` } : {}),
	};
}

/**
 * Deliver the work of a finished agent as the environment says. Returns null
 * for output `none` (or no output). Throws {@link OutputError} (secret values
 * redacted) when the commit, the push or the pull request fails.
 */
export async function deliverOutput(
	i: OutputInput,
): Promise<OutputResult | null> {
	const kind = i.output?.kind;
	if (kind !== "pr" && kind !== "branch") return null;
	const fail = (what: string, detail: string): never => {
		throw new OutputError(redact(`${what}: ${detail}`, i.secrets));
	};
	const must = async (what: string, cmd: string[]) => {
		const r = await i.exec(cmd);
		if (r.code !== 0) fail(what, `exited ${r.code}: ${tail(r)}`);
		return r.stdout;
	};

	// 1. Commit what the agent left uncommitted.
	await must("git add", ["git", "add", "-A"]);
	const staged = await i.exec(["git", "diff", "--cached", "--quiet"]);
	const author = i.author ?? MASTERMIND_IDENTITY;
	if (staged.code === 1)
		await must("git commit", [
			"git",
			"-c",
			`user.name=${author.name}`,
			"-c",
			`user.email=${author.email}`,
			"commit",
			"-q",
			"--no-verify",
			"-m",
			`${i.title}\n\nMastermind item ${i.itemId}`,
		]);
	else if (staged.code !== 0) fail("git diff", tail(staged));

	// 2. New commits? Then a bundle of them (HEAD, without the base) comes out.
	const count = Number(
		(
			await must("git rev-list", [
				"git",
				"rev-list",
				"--count",
				`${i.baseSha}..HEAD`,
			])
		).trim(),
	);
	const none = (): OutputResult => ({
		kind,
		commits: 0,
		filesChanged: 0,
		line: "no changes: nothing pushed",
	});
	if (!count) return none();
	await must("git bundle", [
		"git",
		"bundle",
		"create",
		BUNDLE,
		"HEAD",
		`^${i.baseSha}`,
	]);
	let bundle: Uint8Array;
	try {
		bundle = await i.takeOut(BUNDLE);
	} catch (error) {
		return fail("take out the bundle", String(error));
	}

	// 3. On this machine: a fresh repo with only the credential; the base from
	// the git host, the commits from the bundle (checked), push mm/<item>.
	const branch = outputBranch(i.itemId);
	const host = i.host ?? hostRun;
	const dir = await mkdtemp(join(tmpdir(), "mm-push-"));
	let commits: number;
	let files: number;
	try {
		const ws = join(dir, "ws");
		const file = join(dir, "out.bundle");
		await writeFile(file, bundle, { mode: 0o600 });
		const env = await gitEnv(i.secrets, dir);
		const git = async (what: string, args: string[], ok = false) => {
			const r = await host(["git", ...args], {
				cwd: ws,
				env,
				...(i.signal ? { signal: i.signal } : {}),
			});
			if (r.code !== 0 && !ok) fail(what, `exited ${r.code}: ${tail(r)}`);
			return r;
		};
		const init = await host(["git", "init", "-q", ws], { env });
		if (init.code !== 0) fail("git init on the runner", tail(init));
		await git("git remote", ["remote", "add", "origin", i.repo]);
		await git(`fetch ${i.ref || "HEAD"}`, [
			"fetch",
			"-q",
			"--depth",
			"1",
			"origin",
			i.ref || "HEAD",
		]);
		const has = await git(
			"cat-file",
			["cat-file", "-e", `${i.baseSha}^{commit}`],
			true,
		);
		if (has.code !== 0)
			// The ref moved since the clone: fetch the base commit itself.
			await git(`fetch ${i.baseSha}`, [
				"fetch",
				"-q",
				"--depth",
				"1",
				"origin",
				i.baseSha,
			]);
		await git("take the bundle", [
			"-c",
			"fetch.fsckObjects=true",
			"fetch",
			"-q",
			file,
			"HEAD",
		]);
		const tip = (
			await git("rev-parse", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
		).stdout.trim();
		commits = Number(
			(
				await git("rev-list", ["rev-list", "--count", `${i.baseSha}..${tip}`])
			).stdout.trim(),
		);
		files = (await git("diff", ["diff", "--name-only", i.baseSha, tip])).stdout
			.split("\n")
			.filter(Boolean).length;
		if (!commits || !files) return none();
		// Force: a retry starts again from the base. One ref, set here.
		await git(`git push ${branch}`, [
			"push",
			"-q",
			"--force",
			"origin",
			`${tip}:refs/heads/${branch}`,
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const what = pushedWhat(branch, commits, files);
	const res: OutputResult = {
		kind,
		branch,
		commits,
		filesChanged: files,
		line: `pushed ${what}`,
	};
	if (kind === "branch") return res;
	return pullRequest(i, res, what);
}

/** `branch mm/x (2 commits, 3 files)`: for the ticket line. */
export function pushedWhat(
	branch: string,
	commits: number,
	files: number,
): string {
	return `branch ${branch} (${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"})`;
}

/**
 * After the push of `res.branch`: on GitHub, open the pull request against
 * the base, or find the open one of an earlier try (the push updated it).
 * Other hosts or no token: `res` with a line that says why there is none.
 */
export async function pullRequest(
	i: Pick<
		OutputInput,
		| "repo"
		| "ref"
		| "itemId"
		| "title"
		| "output"
		| "secrets"
		| "fetch"
		| "githubApi"
	>,
	res: OutputResult,
	what: string,
): Promise<OutputResult> {
	const branch = res.branch ?? outputBranch(i.itemId);
	const fail = (what: string, detail: string): never => {
		throw new OutputError(redact(`${what}: ${detail}`, i.secrets));
	};
	const tokenName = gitTokenName(i.secrets);
	const token = tokenName ? i.secrets[tokenName] : undefined;
	const gh = githubRepo(i.repo);
	if (!gh) {
		res.line = `pushed ${what}; no pull request: ${hostOf(i.repo)} is not GitHub, open it by hand`;
		return res;
	}
	if (!token) {
		res.line = `pushed ${what}; no pull request: no token secret (${GIT_TOKEN_SECRETS.join(", ")})`;
		return res;
	}
	const api = (i.githubApi ?? "https://api.github.com").replace(/\/$/, "");
	const f = i.fetch ?? fetch;
	const call = async (method: string, path: string, body?: unknown) => {
		let r: Response;
		try {
			r = await f(`${api}/repos/${gh.owner}/${gh.repo}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "mastermind-runner",
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			return fail(`GitHub ${method} ${path}`, String(error));
		}
		const text = await r.text();
		if (!r.ok)
			fail(`GitHub ${method} ${path}`, `${r.status} ${text.slice(0, 300)}`);
		return JSON.parse(text || "null") as unknown;
	};

	// An open pull request of an earlier try: the push updated it.
	const open = (await call(
		"GET",
		`/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${branch}`)}`,
	)) as { html_url?: string }[];
	const existing = Array.isArray(open) ? open[0]?.html_url : undefined;
	if (existing) {
		res.prUrl = existing;
		res.line = `pull request updated: ${existing} (${what})`;
		return res;
	}
	let base = i.output?.base || i.ref;
	if (!base || base === "HEAD" || /^[0-9a-f]{7,40}$/i.test(base)) {
		const r = (await call("GET", "")) as { default_branch?: string };
		base = r?.default_branch ?? "main";
	}
	const pr = (await call("POST", "/pulls", {
		title: i.title,
		head: branch,
		base,
		body: `Work of Mastermind item \`${i.itemId}\`, done by an agent in a box.\n\nClosing the item does not merge this pull request.`,
	})) as { html_url?: string };
	if (!pr?.html_url) fail("GitHub POST /pulls", "no html_url in the reply");
	res.prUrl = pr.html_url;
	res.line = `pull request opened: ${pr.html_url} (${what} into ${base})`;
	return res;
}
