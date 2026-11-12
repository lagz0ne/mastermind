/**
 * The agent step over the Paseo SDK connection on a real engine (mm-210.73),
 * against `docker exec paseo run` (the exec path). Runs only with
 * MM_BOX_DOCKER_HOST (see network.integration.test.ts):
 *
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock bun test test/box/paseo-control.integration
 *
 * The agent is Paseo's own `mock` provider (no model credential): its answer
 * is not the result JSON, so both paths end with a schema failure. What is
 * measured: the agent was created, finished and its answer read, and how long
 * each path took.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver, dockerEndpoint } from "../../src/box/docker.ts";
import { BOX_LABEL } from "../../src/box/driver.ts";
import {
	runAgentOverPaseo,
	runCommandOverPaseo,
} from "../../src/box/paseo-control.ts";
import {
	dockerExecStream,
	linkDriver,
	paseoLinkOf,
} from "../../src/box/paseo-link.ts";
import {
	BOX_ENV,
	type BoxTask,
	paseoRun,
	sweepBoxes,
} from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-ctl-${process.pid}`;
const env = { DOCKER_HOST: host };
const driver = new DockerDriver({ env });
const dir = join(await mkdtemp(join(tmpdir(), "mm-pc-")), "l");

afterAll(async () => {
	if (!host) return;
	await sweepBoxes(driver, runnerId);
	await rm(join(dir, ".."), { recursive: true, force: true });
});

const task: BoxTask = {
	executionId: `it-ctl-${process.pid}`,
	beadId: "mm-it-ctl",
	runnerId,
	title: "probe: mm-210.73 control",
	prompt: "say hello",
	env: {
		name: "it",
		repo: "",
		ref: "",
		requires: [],
		image: "",
		tools: [],
		recipeHash: "",
		setup: [],
		check: [],
		limits: { cpu: 2, memoryMb: 2048, timeoutMin: 10 },
		network: "open",
	},
	agent: { provider: "mock/e2e-fast-stream", mode: "load-test" },
	secrets: {},
};

describe.skipIf(!host)("box control over Paseo on a real engine", () => {
	test("SDK agent step vs exec 'paseo run'", async () => {
		const linked = linkDriver(driver, {
			dir,
			runnerId,
			register: false,
			open: dockerExecStream(dockerEndpoint(env)),
		});
		const img = await driver.ensureImage({ image });
		const box = await linked.create({
			image: img,
			name: `mm-it-ctl-${process.pid}`,
			labels: {
				[BOX_LABEL.runner]: runnerId,
				[BOX_LABEL.item]: task.beadId,
				[BOX_LABEL.execution]: task.executionId,
			},
			// Dev mode: the daemon offers Paseo's mock provider.
			env: { ...BOX_ENV, PASEO_NODE_ENV: "development" },
		});
		await box.exec(["mkdir", "-p", "/workspace"]);
		const t0 = performance.now();
		const c = await paseoLinkOf(box)?.client();
		if (!c) throw new Error("no link");
		const tConnect = performance.now() - t0;

		// Setup/check commands through a terminal vs Docker exec (mm-210.74).
		const cmds = [
			"echo out; echo err >&2; exit 3",
			"seq 1 300",
			`printf '%0600d\\n' 7`,
			"true",
		];
		const term: number[] = [];
		const ex: number[] = [];
		for (const cmd of cmds) {
			let t = performance.now();
			const r = await runCommandOverPaseo(c, cmd, {
				cwd: "/workspace",
				signal: new AbortController().signal,
			});
			term.push(performance.now() - t);
			t = performance.now();
			const e = await box.exec(["sh", "-c", cmd], { workdir: "/workspace" });
			ex.push(performance.now() - t);
			expect(r.code).toBe(e.code);
			if (cmd.startsWith("seq")) {
				expect(r.stdout.split("\n")).toHaveLength(300);
				expect(r.stdout.split("\n").at(-1)).toBe("300");
			}
			if (cmd.startsWith("echo")) expect(r.stdout).toBe("out\nerr");
			if (cmd.startsWith("printf"))
				expect(r.stdout.replaceAll("\n", "")).toHaveLength(600);
		}
		console.log(
			`box commands: terminal ${term.map(Math.round).join(", ")} ms; docker exec ${ex.map(Math.round).join(", ")} ms`,
		);

		const sdk: number[] = [];
		for (let i = 0; i < 3; i++) {
			const t = performance.now();
			const r = await runAgentOverPaseo(
				c,
				{ ...task, executionId: `${task.executionId}-${i}` },
				new AbortController().signal,
			);
			sdk.push(performance.now() - t);
			// The mock answers text, not the result JSON: read, then refused.
			expect(r.stderr).toMatch(
				/does not match the result schema|finished without an answer/,
			);
		}
		const exec: number[] = [];
		for (let i = 0; i < 3; i++) {
			const t = performance.now();
			const r = await box.exec(
				paseoRun({ ...task, executionId: `${task.executionId}-x${i}` }),
				{ workdir: "/workspace" },
			);
			exec.push(performance.now() - t);
			expect(r.code).not.toBe(0);
		}
		const ms = (xs: number[]) => xs.map((x) => Math.round(x)).join(", ");
		console.log(
			`box control: daemon + connection ${Math.round(tConnect)} ms; agent step (3 tries each) SDK ${ms(sdk)} ms; exec 'paseo run' ${ms(exec)} ms`,
		);
		await box.destroy();
	}, 600_000);
});
