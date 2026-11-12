/**
 * A real Claude task in the default box image (bead mm-210.56). Runs only with
 * MM_BOX_DOCKER_HOST, MM_BOX_CLAUDE=1 and CLAUDE_CODE_OAUTH_TOKEN (from
 * `claude setup-token`; never printed). It uses the model quota of that token.
 *
 *   podman system service --time=0 unix://$XDG_RUNTIME_DIR/mm-box.sock &
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock MM_BOX_CLAUDE=1 \
 *     bun test test/box/claude.integration
 *
 * MM_BOX_TEST_IMAGE: the default image to use (for example a local build of
 * apps/runner/box before CI publishes it); else DEFAULT_BOX_IMAGE.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver } from "../../src/box/docker.ts";
import { BOX_LABEL } from "../../src/box/driver.ts";
import { DEFAULT_BOX_IMAGE } from "../../src/box/image.ts";
import { runInBox, sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const on = !!host && process.env.MM_BOX_CLAUDE === "1" && !!token;
const image = process.env.MM_BOX_TEST_IMAGE || DEFAULT_BOX_IMAGE;
const runnerId = `it-claude-${process.pid}`;
const out = mkdtempSync(join(tmpdir(), "mm-box-claude-"));
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });

afterAll(async () => {
	rmSync(out, { recursive: true, force: true });
	if (on) await sweepBoxes(driver, runnerId).catch(() => {});
});

describe.skipIf(!on)("Claude Code in the default box image", () => {
	test("an environment with no image and provider claude completes a real task", async () => {
		const steps: string[] = [];
		const res = await runInBox(
			{
				executionId: `it-claude-${Date.now()}`,
				beadId: "mm-it-claude",
				runnerId,
				title: "box claude probe",
				prompt:
					"Create the file HELLO.md in the current directory with exactly one line: hello from the box. Do not commit. Then report done.",
				env: {
					repo: "https://github.com/octocat/Hello-World.git",
					ref: "master",
					requires: [],
					image: "",
					provider: "claude",
					secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
					limits: { cpu: 2, memoryMb: 2048, timeoutMin: 10 },
					network: "open",
				},
				agent: { provider: "claude" },
				secrets: { CLAUDE_CODE_OAUTH_TOKEN: token ?? "" },
			},
			{
				driver,
				defaultImage: image,
				outDir: out,
				onStep: (l) => steps.push(l),
			},
			new AbortController().signal,
		);
		console.log(`image ${image}\n${steps.join("\n")}\n${res.summary}`);
		expect(res.status).toBe("done");
		const patch = readFileSync(res.patch ?? "", "utf8");
		expect(patch).toContain("+++ b/HELLO.md");
		expect(patch).toContain("hello from the box");
		expect(patch).not.toContain(token ?? "-");
		expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
	}, 900_000);
});
