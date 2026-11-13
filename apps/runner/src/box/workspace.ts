/**
 * Code by mount (mm-210.83): the runner, not the box, holds the code.
 *
 *   clean clone   one bare repo per remote on THIS machine (<root>/repos),
 *                 fetched with the environment's credential (the GitHub App
 *                 token or GIT_TOKEN / GIT_SSH_KEY), outside any box
 *   work copy     a fresh repo per task (<root>/work/<execution>) at the base
 *                 commit, filled from the clean clone (no network, no
 *                 credential), bind-mounted into the box at /workspace
 *   changes       read on this machine as DATA: the work tree against the base
 *                 with a temporary index of the clean clone (GIT_DIR = clean
 *                 clone, GIT_WORK_TREE = work copy). The copy's .git (config,
 *                 hooks, refs, objects) is never used, so a hostile change
 *                 there has no effect. One commit (commit-tree: no hooks) on
 *                 the base, pushed from the clean clone to refs/heads/mm/<item>
 *   delete        the work copy goes with the box, on every exit path
 *
 * Prior art: GitHub Actions container jobs (actions/checkout runs on the
 * runner host with the token; the job container mounts the workspace).
 * MM_BOX_CODE=clone keeps the older way (clone in the box, bundle out).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyGitError,
	gitEnv,
	type HostRun,
	hostRun,
} from "./devcontainer.ts";
import type { ExecResult } from "./driver.ts";
import {
	identityEnv,
	MASTERMIND_IDENTITY,
	OutputError,
	type OutputInput,
	type OutputResult,
	outputBranch,
	pullRequest,
	pushedWhat,
	redact,
} from "./output.ts";

/** How the code gets into the box. */
export type CodeMode = "mount" | "clone";

/**
 * MM_BOX_CODE: `mount` (default) or `clone`. An engine on another machine
 * (DOCKER_HOST tcp:// or ssh://) cannot mount this machine's directories:
 * clone, with the reason.
 */
export function codeMode(env: Record<string, string | undefined>): {
	mode: CodeMode;
	why: string;
} {
	const set = env.MM_BOX_CODE?.trim().toLowerCase();
	if (set === "clone") return { mode: "clone", why: "MM_BOX_CODE=clone" };
	const host = env.DOCKER_HOST?.trim();
	if (host && !host.startsWith("unix://"))
		return {
			mode: "clone",
			why: `the box engine is on another machine (DOCKER_HOST ${host.split("://")[0]}://)`,
		};
	return {
		mode: "mount",
		why:
			set === "mount"
				? "MM_BOX_CODE=mount"
				: "default (MM_BOX_CODE=clone: clone in the box)",
	};
}

/** One task's code: the work copy and where it came from. */
export type WorkCopy = {
	/** The work copy on this machine (mounted at /workspace). */
	dir: string;
	/** The clean clone (bare) it was filled from. */
	clean: string;
	repo: string;
	ref: string;
	/** The checked-out commit. */
	base: string;
	/** Keeps the base in the clean clone until the copy is removed. */
	baseRef: string;
};

/** The work tree against the base, as data. */
export type Snapshot = {
	/** Tree of the work tree (in the clean clone's objects). */
	tree: string;
	/** Changed files (added, changed, deleted). */
	files: number;
	/** `git diff --binary` of the changes; empty: none. */
	patch: string;
};

/** Git with no config of this machine or of the user: only what we pass. */
const SAFE_ENV: Record<string, string> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};
/** Settings no repo config or attribute can turn into a command. */
const SAFE_CONFIG = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"core.bare=false",
	"-c",
	"core.symlinks=true",
];

const tail = (r: ExecResult, n = 400) =>
	`${r.stdout}${r.stderr}`.trim().slice(-n);

/** File name part of an execution id. */
function safeName(s: string): string {
	return s.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
}

export type CodeStoreOptions = {
	/** Git on this machine; default: spawn. */
	host?: HostRun;
	log?: (line: string) => void;
};

/**
 * The clean clones and the work copies under `root` (0700). One runner
 * process per machine (runner.pid), so an in-process lock per clean clone
 * is enough.
 */
export class CodeStore {
	readonly #host: HostRun;
	readonly #log: (line: string) => void;
	readonly #locks = new Map<string, Promise<unknown>>();

	constructor(
		readonly root: string,
		o: CodeStoreOptions = {},
	) {
		this.#host = o.host ?? hostRun;
		this.#log = o.log ?? (() => {});
	}

	get workRoot(): string {
		return join(this.root, "work");
	}

	/** Run `fn` alone for this clean clone. */
	async #locked<T>(clean: string, fn: () => Promise<T>): Promise<T> {
		const before = this.#locks.get(clean) ?? Promise.resolve();
		const mine = before.catch(() => {}).then(fn);
		this.#locks.set(clean, mine);
		try {
			return await mine;
		} finally {
			if (this.#locks.get(clean) === mine) this.#locks.delete(clean);
		}
	}

	async #git(
		what: string,
		args: string[],
		o: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
		secrets: Record<string, string> = {},
	): Promise<string> {
		const r = await this.#host(["git", ...args], {
			...(o.cwd ? { cwd: o.cwd } : {}),
			env: { ...SAFE_ENV, ...o.env },
			...(o.signal ? { signal: o.signal } : {}),
		});
		if (r.code !== 0)
			throw new OutputError(
				redact(`${what}: exited ${r.code}: ${tail(r)}`, secrets),
			);
		return r.stdout;
	}

	/**
	 * Fetch `ref` of `repo` into its clean clone (with the credential), then
	 * make the work copy of one execution at that commit.
	 */
	async checkout(i: {
		repo: string;
		ref: string;
		executionId: string;
		/** The git credential secrets (output.ts splitGitSecrets). */
		secrets: Record<string, string>;
		signal?: AbortSignal;
	}): Promise<WorkCopy> {
		const signal = i.signal;
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await mkdir(join(this.root, "repos"), { recursive: true, mode: 0o700 });
		await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
		const key = createHash("sha256").update(i.repo).digest("hex").slice(0, 16);
		const clean = join(this.root, "repos", `${key}.git`);
		const ref = i.ref || "HEAD";
		const baseRef = `refs/mm/work/${safeName(i.executionId)}`;
		const base = await this.#locked(clean, async () => {
			await this.#git(
				"git init (clean clone)",
				["init", "-q", "--bare", clean],
				{
					...(signal ? { signal } : {}),
				},
			);
			const tmp = await mkdtemp(join(tmpdir(), "mm-code-"));
			try {
				const env = { ...(await gitEnv(i.secrets, tmp)), GIT_DIR: clean };
				const r = await this.#host(
					["git", "fetch", "-q", "--no-tags", "--depth", "1", i.repo, ref],
					{ env: { ...SAFE_ENV, ...env }, ...(signal ? { signal } : {}) },
				);
				if (r.code !== 0)
					throw new OutputError(
						`clone ${i.repo} at ${ref}: ${classifyGitError(r, i.repo, i.secrets).reason}`,
					);
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
			const sha = (
				await this.#git(
					"rev-parse",
					["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
					{ env: { GIT_DIR: clean } },
				)
			).trim();
			await this.#git("update-ref", ["update-ref", baseRef, sha], {
				env: { GIT_DIR: clean },
			});
			return sha;
		});
		const dir = join(this.workRoot, safeName(i.executionId));
		await rm(dir, { recursive: true, force: true });
		const copy: WorkCopy = { dir, clean, repo: i.repo, ref, base, baseRef };
		try {
			const o = { cwd: dir, ...(signal ? { signal } : {}) };
			await this.#git("git init (work copy)", ["init", "-q", dir], {});
			// From the clean clone: local, no credential, no network.
			await this.#git(
				"fill the work copy",
				[
					"fetch",
					"-q",
					"--no-tags",
					"--depth",
					"1",
					`file://${clean}`,
					baseRef,
				],
				o,
			);
			await this.#git("checkout", ["checkout", "-q", "--detach", base], o);
			// origin as in a clone, without any credential.
			await this.#git("git remote", ["remote", "add", "origin", i.repo], o);
		} catch (error) {
			await this.remove(copy).catch(() => {});
			throw error;
		}
		return copy;
	}

	/**
	 * The work tree of `copy` against its base, read with a temporary index of
	 * the clean clone. `exclude`: patterns left out (the item's files dir).
	 */
	async snapshot(
		copy: WorkCopy,
		o: { exclude?: string[]; signal?: AbortSignal } = {},
	): Promise<Snapshot> {
		const tmp = await mkdtemp(join(tmpdir(), "mm-snap-"));
		try {
			const excludes = join(tmp, "exclude");
			await writeFile(
				excludes,
				(o.exclude ?? []).map((p) => `${p}\n`).join(""),
			);
			const env = {
				GIT_DIR: copy.clean,
				GIT_WORK_TREE: copy.dir,
				GIT_INDEX_FILE: join(tmp, "index"),
				HOME: tmp,
			};
			const git = (what: string, args: string[]) =>
				this.#git(
					what,
					[...SAFE_CONFIG, "-c", `core.excludesFile=${excludes}`, ...args],
					{ cwd: copy.dir, env, ...(o.signal ? { signal: o.signal } : {}) },
				);
			await git("read-tree", ["read-tree", copy.base]);
			await git("git add", ["add", "-A", "--", "."]);
			const tree = (await git("write-tree", ["write-tree"])).trim();
			const names = await git("diff --name-only", [
				"diff",
				"--cached",
				"--no-ext-diff",
				"--no-textconv",
				"--name-only",
				copy.base,
			]);
			const files = names.split("\n").filter(Boolean).length;
			const patch = files
				? await git("diff", [
						"diff",
						"--cached",
						"--no-ext-diff",
						"--no-textconv",
						"--binary",
						copy.base,
					])
				: "";
			return { tree, files, patch };
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	/**
	 * Deliver a snapshot as the environment says: one commit on the base,
	 * pushed from the clean clone to mm/<item> (force: a retry starts again
	 * from the base); output pr: the pull request (output.ts). Null for
	 * output `none`. Throws {@link OutputError} with secret values redacted.
	 */
	async deliver(
		copy: WorkCopy,
		snap: Snapshot,
		i: Pick<
			OutputInput,
			| "itemId"
			| "title"
			| "output"
			| "secrets"
			| "author"
			| "fetch"
			| "githubApi"
			| "signal"
		>,
	): Promise<OutputResult | null> {
		const kind = i.output?.kind;
		if (kind !== "pr" && kind !== "branch") return null;
		if (!snap.files)
			return {
				kind,
				commits: 0,
				filesChanged: 0,
				line: "no changes: nothing pushed",
			};
		const branch = outputBranch(i.itemId);
		const signal = i.signal;
		const author = identityEnv(i.author ?? MASTERMIND_IDENTITY);
		const commit = (
			await this.#git(
				"commit-tree",
				[
					"commit-tree",
					snap.tree,
					"-p",
					copy.base,
					"-m",
					`${i.title}\n\nMastermind item ${i.itemId}`,
				],
				{ env: { GIT_DIR: copy.clean, ...author } },
			)
		).trim();
		const tmp = await mkdtemp(join(tmpdir(), "mm-push-"));
		try {
			const env = { ...(await gitEnv(i.secrets, tmp)), GIT_DIR: copy.clean };
			await this.#git(
				`git push ${branch}`,
				[
					"push",
					"-q",
					"--force",
					"--no-verify",
					copy.repo,
					`${commit}:refs/heads/${branch}`,
				],
				{ env, ...(signal ? { signal } : {}) },
				i.secrets,
			);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
		const what = pushedWhat(branch, 1, snap.files);
		const res: OutputResult = {
			kind,
			branch,
			commits: 1,
			filesChanged: snap.files,
			line: `pushed ${what}`,
		};
		if (kind === "branch") return res;
		return pullRequest({ ...i, repo: copy.repo, ref: copy.ref }, res, what);
	}

	/**
	 * Delete the work copy and its base ref. Files the box user still owns
	 * (a box killed before it gave them back) go through `wipe` (as root in a
	 * short box). Throws when the copy stays.
	 */
	async remove(
		copy: WorkCopy,
		wipe?: (dir: string) => Promise<void>,
	): Promise<void> {
		await this.#locked(copy.clean, () =>
			this.#git("update-ref -d", ["update-ref", "-d", copy.baseRef], {
				env: { GIT_DIR: copy.clean },
			}),
		).catch(() => {});
		await removeDir(copy.dir, wipe);
	}

	/**
	 * Delete the work copies an earlier run left (at start: none in flight).
	 * Returns their names.
	 */
	async sweep(wipe?: (dir: string) => Promise<void>): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.workRoot);
		} catch {
			return [];
		}
		const gone: string[] = [];
		for (const n of names) {
			try {
				await removeDir(join(this.workRoot, n), wipe);
				gone.push(n);
			} catch (error) {
				this.#log(`box: work copy ${n} stays: ${error}`);
			}
		}
		return gone;
	}
}

async function removeDir(
	dir: string,
	wipe?: (dir: string) => Promise<void>,
): Promise<void> {
	try {
		await rm(dir, { recursive: true, force: true });
		return;
	} catch (error) {
		if (!wipe) throw error;
	}
	await wipe(dir);
	await rm(dir, { recursive: true, force: true });
}
