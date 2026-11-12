/**
 * The git credential is out of the agent's reach (mm-210.64), on a real
 * engine: the clone of a repo works with a token and a deploy key set, and
 * then, as the agent, nothing in the box holds either value: not the env of
 * the agent or of the box's main process, not a file (secrets dir, the clone
 * credential dir, .git, /tmp, home dirs), not git config. The push after the
 * agent runs on the runner machine (output.test.ts, real git).
 * Runs only with MM_BOX_DOCKER_HOST (see docker.integration.test.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { DockerDriver } from "../../src/box/docker.ts";
import { CLONE_CRED_DIR } from "../../src/box/output.ts";
import { runInBox, SECRETS_DIR, sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-cred-${process.pid}`;
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });

afterAll(async () => {
	if (host) await sweepBoxes(driver, runnerId).catch(() => {});
});

const TOKEN = "ghp_mmItTokenValue0123456789";
const KEY = "mm-it-deploy-key-value-0123456789";

describe.skipIf(!host)("git credential in a real box", () => {
	test("after the clone, the agent finds no token, no key, no credential config", async () => {
		// The agent: look everywhere it can; report each place a value shows.
		const agent = [
			"found=''",
			`for v in ${TOKEN} ${KEY}; do`,
			'  env | grep -qF "$v" && found="$found env:$v"',
			'  tr "\\0" "\\n" < /proc/1/environ | grep -qF "$v" && found="$found pid1-env:$v"',
			`  f="$(grep -rlF "$v" ${SECRETS_DIR} /run/mastermind /workspace/.git /tmp /home /root 2>/dev/null | tr "\\n" " ")"`,
			'  [ -n "$f" ] && found="$found file:$f"',
			"done",
			// Control: the search does find a secret that is meant for the box.
			`env | grep -qF s3cret && grep -qF s3cret ${SECRETS_DIR}/MM_IT_SECRET || found="$found control-missed"`,
			'git config -l --show-origin | grep -qiE "credential|sshcommand|insteadof|extraheader" && found="$found git-config"',
			`test -e ${CLONE_CRED_DIR} && found="$found ${CLONE_CRED_DIR}"`,
			'test -f README || found="$found no-checkout"',
			'if [ -z "$found" ]; then echo \'{"status":"done","summary":"clean"}\'; else echo "{\\"status\\":\\"failed\\",\\"summary\\":\\"found:$found\\"}"; fi',
		].join("\n");
		const res = await runInBox(
			{
				executionId: `it-cred-${Date.now()}`,
				beadId: "mm-it",
				runnerId,
				title: "credential check",
				prompt: "look for credentials",
				env: {
					repo: "https://github.com/octocat/Hello-World.git",
					ref: "master",
					requires: [],
					image,
					limits: { cpu: 1, memoryMb: 1024, timeoutMin: 10 },
					network: "open",
				},
				agent: {},
				secrets: {
					GITHUB_TOKEN: TOKEN,
					GIT_SSH_KEY: KEY,
					MM_IT_SECRET: "s3cret",
				},
			},
			{
				driver,
				defaultImage: image,
				agentCommand: () => ["sh", "-c", agent],
				readyCommand: null,
			},
			new AbortController().signal,
		);
		expect(res.summary).toBe("clean");
		expect(res.status).toBe("done");
	}, 300_000);
});
