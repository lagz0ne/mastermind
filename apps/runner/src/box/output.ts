/**
 * How code leaves the box (human decision C, 2026-11-11): through the git host.
 *
 *   agent done -> commit what is left -> nothing changed? say so, push nothing
 *   -> push branch mm/<item> (force: a retry starts again from the base)
 *   -> output pr on GitHub: open a pull request against the base, or find the
 *      open one of an earlier try (the push updated it)
 *
 * Other git hosts: the branch is pushed, the pull request is opened by hand.
 * The git credential is one of the environment's secrets (GIT_TOKEN,
 * GITHUB_TOKEN or GH_TOKEN; or GIT_SSH_KEY, a deploy key), set on the checkout
 * before the clone ({@link gitCredentialScript}): no value in argv or a URL.
 */
import type { EnvironmentOutput } from "@mastermind/core";
import type { ExecResult } from "./driver.ts";

/** Secret names a token for `git push` and the GitHub API is read from, in order. */
export const GIT_TOKEN_SECRETS = ["GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
/** Secret name of an SSH deploy key (a file in the box). */
export const GIT_SSH_KEY_SECRET = "GIT_SSH_KEY";

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
	/** Runs a command in the checkout of the box. */
	exec: (cmd: string[]) => Promise<ExecResult>;
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
	/** Resolved secret values, by name: the token for the GitHub API. */
	secrets: Record<string, string>;
	fetch?: typeof fetch;
	/** GitHub REST API base; default https://api.github.com. */
	githubApi?: string;
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

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The token secret for git and the GitHub API: the first of {@link GIT_TOKEN_SECRETS} given. */
export function gitTokenName(
	secrets: Record<string, string>,
): string | undefined {
	return GIT_TOKEN_SECRETS.find((n) => secrets[n]);
}

/**
 * Shell lines that set the git credential of the checkout (run after `git
 * init`, before the fetch, so the clone of a private repo and the push both
 * use it). The helper reads the token FILE when git asks: the value is never
 * in a URL, in argv or in .git/config. A deploy key becomes core.sshCommand
 * (a 0600 copy: ssh refuses a key others can read).
 */
export function gitCredentialScript(
	secrets: Record<string, string>,
	secretsDir: string,
): string {
	const lines: string[] = [];
	const name = gitTokenName(secrets);
	if (name && ENV_NAME.test(name))
		lines.push(
			`git config credential.helper '!f() { test "$1" = get || exit 0; echo username=x-access-token; printf "password=%s\\n" "$(cat ${secretsDir}/${name})"; }; f'`,
		);
	if (GIT_SSH_KEY_SECRET in secrets)
		lines.push(
			`k="$(pwd)/.git/mastermind-git-key" && cp ${secretsDir}/${GIT_SSH_KEY_SECRET} "$k" && chmod 600 "$k" && git config core.sshCommand "ssh -i $k -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`,
		);
	return lines.join(" && ");
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
	if (staged.code === 1)
		await must("git commit", [
			"git",
			"-c",
			"user.name=Mastermind",
			"-c",
			"user.email=mastermind@users.noreply.github.com",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			`${i.title}\n\nMastermind item ${i.itemId}`,
		]);
	else if (staged.code !== 0) fail("git diff", tail(staged));

	// 2. What changed against the base.
	const commits = Number(
		(
			await must("git rev-list", [
				"git",
				"rev-list",
				"--count",
				`${i.baseSha}..HEAD`,
			])
		).trim(),
	);
	const files = (
		await must("git diff", ["git", "diff", "--name-only", i.baseSha, "HEAD"])
	)
		.split("\n")
		.filter(Boolean).length;
	if (!commits || !files)
		return {
			kind,
			commits: 0,
			filesChanged: 0,
			line: "no changes: nothing pushed",
		};

	// 3. Push mm/<item>. Force: a retry starts again from the base.
	const branch = outputBranch(i.itemId);
	const tokenName = gitTokenName(i.secrets);
	const token = tokenName ? i.secrets[tokenName] : undefined;
	await must(`git push ${branch}`, [
		"git",
		"push",
		"-q",
		"--force",
		"origin",
		`HEAD:refs/heads/${branch}`,
	]);
	const what = `branch ${branch} (${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"})`;
	const res: OutputResult = {
		kind,
		branch,
		commits,
		filesChanged: files,
		line: `pushed ${what}`,
	};
	if (kind === "branch") return res;

	// 4. The pull request (GitHub only).
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
