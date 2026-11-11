/**
 * The box on a real engine. Runs only with MM_BOX_DOCKER_HOST, for example
 * Podman's Docker-compatible socket:
 *
 *   podman system service --time=0 unix://$XDG_RUNTIME_DIR/mm-box.sock &
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock bun test test/box/docker.integration
 *
 * MM_BOX_TEST_IMAGE: the box image (default: the Paseo image, which has git
 * and the Paseo daemon). Needs network for the clone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver } from "../../src/box/docker.ts";
import { BOX_LABEL } from "../../src/box/driver.ts";
import { runInBox, sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-${process.pid}`;
const out = mkdtempSync(join(tmpdir(), "mm-box-it-"));
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });

afterAll(async () => {
	rmSync(out, { recursive: true, force: true });
	if (host) await sweepBoxes(driver, runnerId).catch(() => {});
});

describe.skipIf(!host)("box on a real engine", () => {
	test("recipe -> box -> clone, secrets, setup, check, Paseo daemon, fake agent -> patch out -> box deleted", async () => {
		const steps: string[] = [];
		const agent = [
			'test "$MM_IT_SECRET" = s3cret',
			'test "$(cat /run/mastermind/secrets/MM_IT_SECRET)" = s3cret',
			"test -f /tmp/setup.ok",
			"paseo ls --json > /dev/null",
			"echo hello > HELLO.md",
			`echo '{"status":"done","summary":"wrote HELLO.md as '"$(id -un)"'"}'`,
		].join(" && ");
		const res = await runInBox(
			{
				executionId: `it-${Date.now()}`,
				beadId: "mm-it",
				runnerId,
				title: "integration",
				prompt: "write HELLO.md",
				env: {
					repo: "https://github.com/octocat/Hello-World.git",
					ref: "master",
					requires: [],
					image,
					setup: ["echo ok > /tmp/setup.ok"],
					check: ["git status --short", "test -f README"],
					limits: { cpu: 1, memoryMb: 1024, timeoutMin: 10 },
					network: "open",
				},
				agent: {},
				secrets: { MM_IT_SECRET: "s3cret" },
			},
			{
				driver,
				defaultImage: image,
				outDir: out,
				agentCommand: () => ["sh", "-c", agent],
				onStep: (l) => steps.push(l),
			},
			new AbortController().signal,
		);
		console.log(steps.join("\n"));
		expect(res.status).toBe("done");
		expect(res.summary).toContain("wrote HELLO.md");
		const patch = readFileSync(res.patch ?? "", "utf8");
		expect(patch).toContain("+++ b/HELLO.md");
		expect(patch).not.toContain("s3cret");
		expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
	}, 600_000);

	test("a runner killed mid-task leaves a box; the sweep at the next start deletes it", async () => {
		const child = Bun.spawn(
			["bun", join(import.meta.dir, "box-child.ts"), runnerId, image],
			{ stdout: "pipe", stderr: "inherit", env: process.env },
		);
		const reader = child.stdout.getReader();
		let seen = "";
		while (!seen.includes("READY")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`child ended early: ${seen}`);
			seen += new TextDecoder().decode(value);
		}
		child.kill("SIGKILL");
		await child.exited;
		const left = await driver.list({ [BOX_LABEL.runner]: runnerId });
		expect(left.length).toBe(1);
		const gone = await sweepBoxes(driver, runnerId);
		expect(gone).toEqual(left.map((b) => b.name));
		expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
	}, 600_000);
});
