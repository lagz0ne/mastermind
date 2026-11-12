/**
 * The box from devcontainer.json on a real engine (mm-210.62). Slow (image
 * pulls and builds): runs only with MM_BOX_DOCKER_HOST and
 * MM_BOX_DEVCONTAINER_IT=1 (see docker.integration.test.ts), for example:
 *
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock MM_BOX_DEVCONTAINER_IT=1 \
 *     bun test test/box/devcontainer.integration
 *
 * Needs network (GitHub, the image registries). The devcontainer CLI runs as
 * the runner does: the pinned npm package through Bun.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBox } from "../../src/box/devcontainer.ts";
import { DockerDriver } from "../../src/box/docker.ts";
import { DEFAULT_BOX_IMAGE } from "../../src/box/image.ts";
import { boxDockerPath } from "../../src/box/launcher.ts";
import {
	BoxStepError,
	type BoxTask,
	runInBox,
	sweepBoxes,
} from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const on = !!host && process.env.MM_BOX_DEVCONTAINER_IT === "1";
const runnerId = `it-dc-${process.pid}`;
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });
const tmp = mkdtempSync(join(tmpdir(), "mm-dc-it-"));
const marker = join(tmp, "initialize-ran");

afterAll(async () => {
	rmSync(tmp, { recursive: true, force: true });
	if (on) await sweepBoxes(driver, runnerId).catch(() => {});
});

/** The agent: checks the box from inside, then reports done. */
const agent = (checks: string[]) => () => [
	"sh",
	"-c",
	[
		...checks,
		"paseo ls --json > /dev/null",
		"claude --version > /dev/null",
		`echo '{"status":"done","summary":"'"$(id -un)"'"}'`,
	].join(" && "),
];

async function run(env: BoxTask["env"], checks: string[], steps: string[]) {
	const engine = await driver.ping();
	return runInBox(
		{
			executionId: `it-dc-${Date.now()}`,
			beadId: "mm-it-dc",
			runnerId,
			title: "devcontainer",
			prompt: "check",
			env,
			agent: {},
			secrets: {},
		},
		{
			driver,
			defaultImage: DEFAULT_BOX_IMAGE,
			agentCommand: agent(checks),
			readyTimeoutMs: 120_000,
			onStep: (l) => steps.push(l),
			prepare: (task, step, signal) =>
				prepareBox(
					task,
					{
						defaultImage: DEFAULT_BOX_IMAGE,
						dockerPath: boxDockerPath(process.env, engine),
					},
					step,
					signal,
				),
		},
		new AbortController().signal,
	);
}

describe.skipIf(!on)("box from devcontainer.json on a real engine", () => {
	test(
		"a public repo with .devcontainer/devcontainer.json: built by the devcontainer CLI, postCreateCommand ran, Paseo and Claude in the box",
		async () => {
			const steps: string[] = [];
			// microsoft/vscode-remote-try-node: image javascript-node, postCreateCommand npm install.
			const res = await run(
				{
					repo: "https://github.com/microsoft/vscode-remote-try-node.git",
					ref: "main",
					requires: [],
					network: "open",
				},
				["test -d node_modules", "node --version > /dev/null"],
				steps,
			);
			console.log(steps.join("\n"));
			expect(res.status).toBe("done");
			expect(res.summary).toBe("node");
			expect(steps.join("\n")).toContain("devcontainer image mastermind-dc:");
			expect(steps.join("\n")).toContain(
				"devcontainer lifecycle: 1 commands passed",
			);
		},
		20 * 60_000,
	);

	test(
		"the environment's own config (image + feature + postCreateCommand) on a repo without one; initializeCommand never runs on the host",
		async () => {
			const steps: string[] = [];
			const res = await run(
				{
					repo: "https://github.com/octocat/Hello-World.git",
					ref: "master",
					requires: [],
					network: "open",
					devcontainer: {
						config: JSON.stringify({
							image: "mcr.microsoft.com/devcontainers/base:debian",
							features: {
								"ghcr.io/devcontainers/features/node:1": { version: "22" },
							},
							initializeCommand: `touch ${marker}`,
							postCreateCommand: "echo post > /tmp/post.ok",
							containerEnv: { MM_IT: "yes" },
						}),
					},
				},
				[
					"test -f /tmp/post.ok",
					"test -f README",
					'test "$MM_IT" = yes',
					"node --version | grep -q '^v22'",
				],
				steps,
			);
			console.log(steps.join("\n"));
			expect(res.status).toBe("done");
			expect(res.summary).toBe("vscode");
			expect(existsSync(marker)).toBe(false);
			expect(steps.join("\n")).toContain(
				"not applied (they reach the host): initializeCommand",
			);
		},
		20 * 60_000,
	);

	test("a private (or missing) repo without a credential: access check fails, no box", async () => {
		const steps: string[] = [];
		const p = run(
			{
				repo: "https://github.com/lagz0ne/mm-no-such-repo-for-tests.git",
				ref: "main",
				requires: [],
			},
			[],
			steps,
		);
		await expect(p).rejects.toThrow(BoxStepError);
		await expect(p).rejects.toThrow("the environment has no git credential");
		expect(steps.some((s) => s.includes("box "))).toBe(false);
		expect(await driver.list({ "mastermind.runner": runnerId })).toEqual([]);
	});
});
