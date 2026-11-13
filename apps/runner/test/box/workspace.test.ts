/**
 * Code by mount (mm-210.83) with real git on this machine: the clean clone,
 * the work copy, the changes read as data (a hostile .git in the work copy
 * has no effect), the push from the clean clone, and the delete. Then
 * runInBox with the fake driver: the box gets the mount, no clone and no
 * git credential; the work copy is gone on every exit path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLONE_CRED_DIR } from "../../src/box/output.ts";
import { type BoxTask, runInBox } from "../../src/box/run.ts";
import { CodeStore, codeMode } from "../../src/box/workspace.ts";
import { FakeDriver } from "./fake-driver.ts";

const root = mkdtempSync(join(tmpdir(), "mm-ws-test-"));
afterAll(() => {
	// Work copies made unreadable by a test: let rm in.
	Bun.spawnSync(["chmod", "-R", "u+rwX", root]);
	rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

/** The "git host": a bare repo with one commit on main. */
const remote = join(root, "remote.git");
const remoteUrl = `file://${remote}`;
let mainSha = "";
const marker = join(root, "PWNED");
beforeAll(() => {
	const seed = join(root, "seed");
	mkdirSync(seed);
	git(seed, "init", "-q", "-b", "main");
	writeFileSync(join(seed, "README"), "hello\n");
	writeFileSync(join(seed, "keep.txt"), "keep\n");
	writeFileSync(join(seed, "gone.txt"), "gone\n");
	writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
	git(seed, "add", "-A");
	git(seed, "commit", "-q", "-m", "base");
	git(root, "init", "-q", "--bare", remote);
	git(seed, "push", "-q", remote, "main");
	mainSha = git(seed, "rev-parse", "HEAD");
});

/** What a hostile agent leaves in the work copy's .git. */
function poisonGit(dir: string) {
	const cmd = `touch ${marker}`;
	writeFileSync(
		join(dir, ".git", "config"),
		[
			"[core]",
			"\trepositoryformatversion = 0",
			`\tfsmonitor = ${cmd}`,
			"\thooksPath = .git/hooks",
			`\tsshCommand = ${cmd}`,
			'[remote "origin"]',
			`\turl = ${join(root, "elsewhere.git")}`,
			`\tpushurl = ${join(root, "elsewhere.git")}`,
			'[filter "evil"]',
			`\tclean = ${cmd}`,
			`\tsmudge = ${cmd}`,
			'[diff "evil"]',
			`\ttextconv = ${cmd}`,
			"",
		].join("\n"),
	);
	for (const h of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
		const p = join(dir, ".git", "hooks", h);
		writeFileSync(p, `#!/bin/sh\n${cmd}\n`);
		chmodSync(p, 0o755);
	}
	writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
}

let n = 0;
const exec = () => `ex-${process.pid}-${++n}`;

describe("codeMode", () => {
	test("mount by default; clone when set or when the engine is remote", () => {
		expect(codeMode({}).mode).toBe("mount");
		expect(codeMode({ MM_BOX_CODE: "clone" }).mode).toBe("clone");
		expect(codeMode({ DOCKER_HOST: "unix:///run/docker.sock" }).mode).toBe(
			"mount",
		);
		const r = codeMode({ DOCKER_HOST: "tcp://10.0.0.2:2375" });
		expect(r.mode).toBe("clone");
		expect(r.why).toContain("another machine");
	});
});

describe("CodeStore with real git", () => {
	const store = new CodeStore(join(root, "code"));

	test("checkout: a work copy at the base, origin without credential, 0700 root", async () => {
		const copy = await store.checkout({
			repo: remoteUrl,
			ref: "main",
			executionId: exec(),
			secrets: { GIT_TOKEN: "tok-0123456789" },
		});
		expect(copy.base).toBe(mainSha);
		expect(readFileSync(join(copy.dir, "README"), "utf8")).toBe("hello\n");
		expect(git(copy.dir, "rev-parse", "HEAD")).toBe(mainSha);
		expect(git(copy.dir, "remote", "get-url", "origin")).toBe(remoteUrl);
		const config = readFileSync(join(copy.dir, ".git", "config"), "utf8");
		expect(config).not.toContain("tok-0123456789");
		expect(config).not.toContain("credential");
		expect(
			Bun.spawnSync(["stat", "-c", "%a", store.root]).stdout.toString().trim(),
		).toBe("700");
		await store.remove(copy);
		expect(existsSync(copy.dir)).toBe(false);
		expect(() =>
			git(root, "--git-dir", copy.clean, "rev-parse", "--verify", copy.baseRef),
		).toThrow();
	});

	test("two tasks on one repo at once: each its own copy", async () => {
		const [a, b] = await Promise.all(
			[exec(), exec()].map((executionId) =>
				store.checkout({
					repo: remoteUrl,
					ref: "main",
					executionId,
					secrets: {},
				}),
			),
		);
		expect(a?.clean).toBe(b?.clean);
		expect(a?.dir).not.toBe(b?.dir);
		for (const c of [a, b]) if (c) await store.remove(c);
	});

	test("a ref that does not exist: the reason, no copy left", async () => {
		const id = exec();
		await expect(
			store.checkout({
				repo: remoteUrl,
				ref: "nope",
				executionId: id,
				secrets: {},
			}),
		).rejects.toThrow(/clone .* at nope/);
		expect(existsSync(join(store.workRoot, id))).toBe(false);
	});

	test("a hostile .git in the work copy has no effect: changes read as data, pushed from the clean clone", async () => {
		const copy = await store.checkout({
			repo: remoteUrl,
			ref: "main",
			executionId: exec(),
			secrets: {},
		});
		// The agent: edits, adds, deletes; commits some of it in its own git;
		// leaves item files and ignored files; poisons .git.
		writeFileSync(join(copy.dir, "README"), "hello agent\n");
		git(copy.dir, "commit", "-q", "-am", "agent commit");
		writeFileSync(join(copy.dir, "new.txt"), "new\n");
		rmSync(join(copy.dir, "gone.txt"));
		mkdirSync(join(copy.dir, ".mastermind", "out"), { recursive: true });
		writeFileSync(join(copy.dir, ".mastermind", "out", "report.md"), "r\n");
		mkdirSync(join(copy.dir, "node_modules"));
		writeFileSync(join(copy.dir, "node_modules", "x.js"), "x\n");
		poisonGit(copy.dir);

		const snap = await store.snapshot(copy, { exclude: ["/.mastermind/"] });
		expect(snap.files).toBe(4); // README, new.txt, gone.txt, .gitattributes
		expect(snap.patch).toContain("hello agent");
		expect(snap.patch).not.toContain("report.md");
		expect(snap.patch).not.toContain("node_modules");

		const out = await store.deliver(copy, snap, {
			itemId: "mm-9",
			title: "mm-9: do it",
			output: { kind: "branch" },
			secrets: {},
		});
		expect(out?.line).toBe("pushed branch mm/mm-9 (1 commit, 4 files)");
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(root, "elsewhere.git"))).toBe(false);
		// On the git host: one commit on the base with the work tree's content.
		const tip = git(root, "--git-dir", remote, "rev-parse", "mm/mm-9");
		expect(git(root, "--git-dir", remote, "rev-parse", `${tip}^`)).toBe(
			mainSha,
		);
		expect(git(root, "--git-dir", remote, "show", `${tip}:README`)).toBe(
			"hello agent",
		);
		expect(
			git(root, "--git-dir", remote, "ls-tree", "--name-only", tip).split("\n"),
		).toEqual([
			".gitattributes",
			".gitignore",
			"README",
			"keep.txt",
			"new.txt",
		]);
		expect(
			git(root, "--git-dir", remote, "log", "-1", "--format=%an %s", tip),
		).toBe("Mastermind mm-9: do it");
		await store.remove(copy);
		expect(existsSync(copy.dir)).toBe(false);
	});

	test("no change: nothing pushed", async () => {
		const copy = await store.checkout({
			repo: remoteUrl,
			ref: "main",
			executionId: exec(),
			secrets: {},
		});
		const snap = await store.snapshot(copy);
		expect(snap).toMatchObject({ files: 0, patch: "" });
		const out = await store.deliver(copy, snap, {
			itemId: "mm-10",
			title: "t",
			output: { kind: "pr" },
			secrets: {},
		});
		expect(out?.line).toBe("no changes: nothing pushed");
		expect(() =>
			git(root, "--git-dir", remote, "rev-parse", "--verify", "mm/mm-10"),
		).toThrow();
		await store.remove(copy);
	});

	test("remove: a copy this machine cannot delete goes through wipe; sweep deletes the rest", async () => {
		const copy = await store.checkout({
			repo: remoteUrl,
			ref: "main",
			executionId: exec(),
			secrets: {},
		});
		const locked = join(copy.dir, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "f"), "x");
		chmodSync(locked, 0o000);
		const wiped: string[] = [];
		await store.remove(copy, async (dir) => {
			wiped.push(dir);
			Bun.spawnSync(["chmod", "-R", "u+rwX", dir]);
		});
		expect(wiped).toEqual([copy.dir]);
		expect(existsSync(copy.dir)).toBe(false);

		const left = await store.checkout({
			repo: remoteUrl,
			ref: "main",
			executionId: exec(),
			secrets: {},
		});
		expect(await store.sweep()).toEqual([left.dir.split("/").pop() ?? ""]);
		expect(readdirSync(store.workRoot)).toEqual([]);
	});
});

/**
 * A private git host over smart HTTP (git http-backend as CGI): every request
 * needs Basic auth x-access-token:<token>, as github.com with an app token.
 */
function privateGitHost(token: string) {
	const project = mkdtempSync(join(root, "http-"));
	git(project, "clone", "-q", "--bare", remote, "repo.git");
	const auths: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const auth = req.headers.get("authorization") ?? "";
			auths.push(auth);
			if (auth !== `Basic ${btoa(`x-access-token:${token}`)}`)
				return new Response("auth", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="git"' },
				});
			const p = Bun.spawn(["git", "http-backend"], {
				env: {
					...GIT_ENV,
					GIT_PROJECT_ROOT: project,
					GIT_HTTP_EXPORT_ALL: "1",
					REQUEST_METHOD: req.method,
					PATH_INFO: url.pathname,
					QUERY_STRING: url.search.slice(1),
					CONTENT_TYPE: req.headers.get("content-type") ?? "",
					HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
					REMOTE_USER: "x-access-token",
					REMOTE_ADDR: "127.0.0.1",
				},
				stdin: new Uint8Array(await req.arrayBuffer()),
				stdout: "pipe",
			});
			const out = Buffer.from(await new Response(p.stdout).arrayBuffer());
			const end = out.indexOf("\r\n\r\n");
			const headers = new Headers();
			let status = 200;
			for (const line of out.subarray(0, end).toString().split("\r\n")) {
				const [k, ...v] = line.split(": ");
				if (!k) continue;
				if (k.toLowerCase() === "status") status = Number.parseInt(v[0] ?? "");
				else headers.append(k, v.join(": "));
			}
			return new Response(out.subarray(end + 4), { status, headers });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/repo.git`,
		bare: join(project, "repo.git"),
		auths,
		stop: () => server.stop(true),
	};
}

describe("CodeStore push to a private git host (mm-210.87)", () => {
	const store = new CodeStore(join(root, "code-http"));

	test("no credential: the push fails as in production; with GIT_TOKEN (the app token) it lands", async () => {
		const token = "ghs_fake-install-token";
		const host = privateGitHost(token);
		try {
			const copy = await store.checkout({
				repo: host.url,
				ref: "main",
				executionId: exec(),
				secrets: { GIT_TOKEN: token },
			});
			writeFileSync(join(copy.dir, "README"), "hello agent\n");
			const snap = await store.snapshot(copy);
			const deliver = (secrets: Record<string, string>) =>
				store.deliver(copy, snap, {
					itemId: "mm-87",
					title: "mm-87: push",
					output: { kind: "branch" },
					secrets,
				});
			await expect(deliver({})).rejects.toThrow(/could not read Username/);
			const out = await deliver({ GIT_TOKEN: token });
			expect(out?.line).toBe("pushed branch mm/mm-87 (1 commit, 1 file)");
			const tip = git(root, "--git-dir", host.bare, "rev-parse", "mm/mm-87");
			expect(git(root, "--git-dir", host.bare, "show", `${tip}:README`)).toBe(
				"hello agent",
			);
			expect(host.auths).toContain(`Basic ${btoa(`x-access-token:${token}`)}`);
			await store.remove(copy);
		} finally {
			host.stop();
		}
	});
});

describe("runInBox with code by mount (fake driver)", () => {
	const store = new CodeStore(join(root, "code-run"));
	function task(over: Partial<BoxTask["env"]> = {}): BoxTask {
		return {
			executionId: exec(),
			beadId: "mm-7",
			runnerId: "laptop",
			title: "mm-7: fix",
			prompt: "fix",
			env: {
				repo: remoteUrl,
				ref: "main",
				requires: [],
				image: "img",
				network: "open",
				output: { kind: "branch" },
				...over,
			},
			agent: {},
			secrets: { GIT_TOKEN: "tok-abcdefgh", OTHER: "v" },
		};
	}

	test("the box gets the mount and no clone; the agent's change is pushed from this machine; the copy is gone", async () => {
		const d = new FakeDriver();
		d.handler = (cmd, o) => {
			if (cmd[0] === "sh" && String(cmd[2]).startsWith('o="$(stat'))
				return { code: 0, stdout: "0:0\n", stderr: "" };
			if (cmd[0] === "agent") {
				const dir = d.created[0]?.mounts?.[0]?.source ?? "";
				writeFileSync(join(dir, "fix.txt"), `fixed as ${o.user}\n`);
				poisonGit(dir);
				return {
					code: 0,
					stdout: JSON.stringify({ status: "done", summary: "ok" }),
					stderr: "",
				};
			}
			return undefined;
		};
		const steps: string[] = [];
		const res = await runInBox(
			task(),
			{
				driver: d,
				defaultImage: "img",
				code: store,
				agentCommand: () => ["agent"],
				readyCommand: null,
				onStep: (l) => steps.push(l),
			},
			new AbortController().signal,
		);
		expect(res.status).toBe("done");
		expect(res.output?.line).toBe("pushed branch mm/mm-7 (1 commit, 2 files)");
		const spec = d.created[0];
		expect(spec?.mounts?.[0]?.target).toBe("/workspace");
		expect(JSON.stringify(spec?.env)).not.toContain("tok-abcdefgh");
		const lines = d.execs.map((e) => e.cmd.join(" "));
		expect(lines.some((l) => /git (init|fetch|clone)/.test(l))).toBe(false);
		expect(lines.some((l) => l.includes(CLONE_CRED_DIR))).toBe(false);
		expect(d.copiedIn.flatMap((c) => c.names)).not.toContain("GIT_TOKEN");
		expect(lines).toContain("sh -c chown -R 0:0 /workspace");
		expect(existsSync(marker)).toBe(false);
		expect(git(root, "--git-dir", remote, "show", "mm/mm-7:fix.txt")).toBe(
			"fixed as paseo",
		);
		expect(readdirSync(store.workRoot)).toEqual([]);
		expect(steps.join("\n")).toContain("no git credential in the box");
		expect(steps).toContain("work copy deleted");
	});

	test("agent fails: the copy is given back and deleted, nothing pushed", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) => {
			if (cmd[0] === "sh" && String(cmd[2]).startsWith('o="$(stat'))
				return { code: 0, stdout: "1000:1000\n", stderr: "" };
			if (cmd[0] === "agent") return { code: 3, stdout: "", stderr: "boom" };
			return undefined;
		};
		await expect(
			runInBox(
				task({ output: { kind: "branch" } }),
				{
					driver: d,
					defaultImage: "img",
					code: store,
					agentCommand: () => ["agent"],
					readyCommand: null,
				},
				new AbortController().signal,
			),
		).rejects.toThrow();
		const lines = d.execs.map((e) => e.cmd.join(" "));
		expect(lines).toContain("sh -c chown -R 1000:1000 /workspace");
		expect(readdirSync(store.workRoot)).toEqual([]);
	});

	test("stopped while the agent runs: box and work copy deleted (wipe when needed)", async () => {
		const d = new FakeDriver();
		const ac = new AbortController();
		d.handler = async (cmd) => {
			if (cmd[0] === "agent") {
				ac.abort();
				await Bun.sleep(10);
				return { code: 137, stdout: "", stderr: "" };
			}
			return undefined;
		};
		await expect(
			runInBox(
				task(),
				{
					driver: d,
					defaultImage: "img",
					code: store,
					agentCommand: () => ["agent"],
					readyCommand: null,
				},
				ac.signal,
			),
		).rejects.toThrow(/stopped/);
		expect(d.boxes.size).toBe(0);
		expect(readdirSync(store.workRoot)).toEqual([]);
	});
});
