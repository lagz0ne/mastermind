/**
 * Code by mount (mm-210.83) on a real engine: the runner's work copy is
 * mounted at /workspace; as the agent, the box holds no git credential (env,
 * files, git config, origin URL) and has no clean clone; the agent edits,
 * leaves a 0600 file and poisons .git; the change arrives as branch mm/<item>
 * pushed from the runner's clean clone; the poison has no effect; no work
 * copy stays. The "git host" is a bare repo on this machine (the box needs
 * no network for the code).
 *
 * Runs only with MM_BOX_DOCKER_HOST (see docker.integration.test.ts).
 * MM_BOX_TIMING=<https repo url>: also time mount against clone in the box
 * (two mount runs: the first fills the clean clone).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver } from "../../src/box/docker.ts";
import { runInBox, SECRETS_DIR, sweepBoxes } from "../../src/box/run.ts";
import { CodeStore } from "../../src/box/workspace.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const timingRepo = process.env.MM_BOX_TIMING;
const runnerId = `it-ws-${process.pid}`;
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });
const root = mkdtempSync(join(tmpdir(), "mm-ws-it-"));
const store = new CodeStore(join(root, "code"));
const remote = join(root, "remote.git");
const marker = join(root, "PWNED");
const TOKEN = "ghp_mmItWsToken0123456789";

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

beforeAll(() => {
	if (!host) return;
	const seed = join(root, "seed");
	mkdirSync(seed);
	git(seed, "init", "-q", "-b", "main");
	writeFileSync(join(seed, "README"), "hello\n");
	git(seed, "add", "-A");
	git(seed, "commit", "-q", "-m", "base");
	git(root, "init", "-q", "--bare", remote);
	git(seed, "push", "-q", remote, "main");
});
afterAll(async () => {
	if (host) await sweepBoxes(driver, runnerId).catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

const agent = [
	"set -u",
	"found=''",
	`env | grep -qF ${TOKEN} && found="$found env"`,
	`tr "\\0" "\\n" < /proc/1/environ | grep -qF ${TOKEN} && found="$found pid1-env"`,
	`f="$(grep -rlF ${TOKEN} ${SECRETS_DIR} /run/mastermind /workspace /tmp /home /root 2>/dev/null | tr "\\n" " ")"`,
	'[ -n "$f" ] && found="$found file:$f"',
	'git config -l --show-origin | grep -qiE "credential|sshcommand|insteadof|extraheader" && found="$found git-config"',
	'git remote get-url origin | grep -q @ && found="$found origin-userinfo"',
	'test -f README || found="$found no-checkout"',
	'test -w README || found="$found not-writable"',
	// The work.
	"echo 'hello box' > README",
	"mkdir -p src && echo secret > src/private.txt && chmod 600 src/private.txt",
	// The poison: fsmonitor, hooks, a filter, another push URL.
	`git config core.fsmonitor 'touch ${marker}'`,
	`git config filter.evil.clean 'touch ${marker}'`,
	`git config remote.origin.pushurl ${join(root, "elsewhere.git")}`,
	"echo '* filter=evil' > .gitattributes",
	`for h in pre-commit post-commit pre-push; do printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/$h; chmod +x .git/hooks/$h; done`,
	'if [ -z "$found" ]; then echo \'{"status":"done","summary":"clean"}\'; else echo "{\\"status\\":\\"failed\\",\\"summary\\":\\"found:$found\\"}"; fi',
].join("\n");

describe.skipIf(!host)("code by mount on a real engine", () => {
	test("no credential in the box; the change is pushed from the clean clone; poison has no effect; no work copy stays", async () => {
		const steps: string[] = [];
		const res = await runInBox(
			{
				executionId: `it-ws-${Date.now()}`,
				beadId: "mm-it-ws",
				runnerId,
				title: "mm-it-ws: edit",
				prompt: "edit",
				env: {
					repo: `file://${remote}`,
					ref: "main",
					requires: [],
					image,
					limits: { cpu: 1, memoryMb: 1024, timeoutMin: 10 },
					network: "open",
					output: { kind: "branch" },
				},
				agent: {},
				secrets: { GIT_TOKEN: TOKEN, MM_IT: "v" },
			},
			{
				driver,
				defaultImage: image,
				code: store,
				agentCommand: () => ["sh", "-c", agent],
				readyCommand: null,
				onStep: (l) => steps.push(l),
			},
			new AbortController().signal,
		);
		console.log(steps.join("\n"));
		expect(res.summary).toContain("clean");
		expect(res.status).toBe("done");
		expect(res.output?.line).toBe(
			"pushed branch mm/mm-it-ws (1 commit, 3 files)",
		);
		expect(git(root, "--git-dir", remote, "show", "mm/mm-it-ws:README")).toBe(
			"hello box",
		);
		expect(
			git(root, "--git-dir", remote, "show", "mm/mm-it-ws:src/private.txt"),
		).toBe("secret");
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(root, "elsewhere.git"))).toBe(false);
		expect(readdirSync(store.workRoot)).toEqual([]);
	}, 300_000);

	test("killed while the agent runs: the work copy (box user's files) is still deleted", async () => {
		const ac = new AbortController();
		const p = runInBox(
			{
				executionId: `it-ws-kill-${Date.now()}`,
				beadId: "mm-it-ws",
				runnerId,
				title: "kill",
				prompt: "kill",
				env: {
					repo: `file://${remote}`,
					ref: "main",
					requires: [],
					image,
					network: "open",
				},
				agent: {},
				secrets: {},
			},
			{
				driver,
				defaultImage: image,
				code: store,
				agentCommand: () => [
					"sh",
					"-c",
					"mkdir -p d && echo x > d/f && chmod 500 d && sleep 600",
				],
				readyCommand: null,
			},
			ac.signal,
		);
		setTimeout(() => ac.abort(), 4000);
		await expect(p).rejects.toThrow(/stopped/);
		expect(readdirSync(store.workRoot)).toEqual([]);
	}, 120_000);

	test.skipIf(!timingRepo)(
		"time: mount against clone in the box",
		async () => {
			const once = async (mount: boolean) => {
				const t0 = Date.now();
				const r = await runInBox(
					{
						executionId: `it-ws-t-${Date.now()}`,
						beadId: "mm-it-ws",
						runnerId,
						title: "time",
						prompt: "time",
						env: {
							repo: timingRepo ?? "",
							ref: "HEAD",
							requires: [],
							image,
							network: "open",
						},
						agent: {},
						secrets: {},
					},
					{
						driver,
						defaultImage: image,
						...(mount ? { code: store } : {}),
						agentCommand: () => [
							"sh",
							"-c",
							'echo x >> README* 2>/dev/null; echo \'{"status":"done","summary":"t"}\'',
						],
						readyCommand: null,
					},
					new AbortController().signal,
				);
				expect(r.status).toBe("done");
				return (Date.now() - t0) / 1000;
			};
			const clone = await once(false);
			const mountCold = await once(true);
			const mountWarm = await once(true);
			console.log(
				`timing ${timingRepo}: clone in box ${clone.toFixed(1)} s; mount cold ${mountCold.toFixed(1)} s; mount warm ${mountWarm.toFixed(1)} s`,
			);
		},
		600_000,
	);
});
