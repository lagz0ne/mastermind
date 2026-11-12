/**
 * The Paseo link on a real engine (mm-210.68). Runs only with
 * MM_BOX_DOCKER_HOST (see network.integration.test.ts), for example:
 *
 *   podman system service --time=0 unix://$XDG_RUNTIME_DIR/mm-box.sock &
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock bun test test/box/paseo-link.integration
 *
 * MM_PASEO_LINK_REAL=1 also registers the box on this machine's own Paseo
 * daemon (`paseo host add`), waits until the host is online, and checks the
 * host is gone after the box is deleted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver, dockerEndpoint } from "../../src/box/docker.ts";
import { BOX_LABEL } from "../../src/box/driver.ts";
import {
	dockerExecStream,
	LINK_META,
	linkDriver,
	type PaseoCall,
	type PaseoLink,
	paseoCall,
	sweepPaseoLinks,
} from "../../src/box/paseo-link.ts";
import { BOX_ENV, sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const real = process.env.MM_PASEO_LINK_REAL === "1";
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-link-${process.pid}`;
const env = { DOCKER_HOST: host };
const driver = new DockerDriver({ env });
const dir = join(await mkdtemp(join(tmpdir(), "mm-pl-")), "l");

afterAll(async () => {
	if (!host) return;
	await sweepBoxes(driver, runnerId);
	if (real) await sweepPaseoLinks({ dir, runnerId });
	await rm(join(dir, ".."), { recursive: true, force: true });
});

const fake: PaseoCall = async (args) =>
	args[1] === "add"
		? { code: 0, stdout: '{"registrationId":"it"}', stderr: "" }
		: { code: 0, stdout: "[]", stderr: "" };

async function hosts(): Promise<
	{
		registrationId: string;
		status: string;
		metadata?: Record<string, string>;
	}[]
> {
	const r = await paseoCall(["host", "ls", "--json"]);
	return JSON.parse(r.stdout || "[]");
}

describe.skipIf(!host)("paseo link on a real engine", () => {
	test("the relay reaches the box daemon; a real Paseo host comes and goes", async () => {
		const steps: string[] = [];
		const linked = linkDriver(driver, {
			dir,
			runnerId,
			open: dockerExecStream(dockerEndpoint(env)),
			paseo: real ? paseoCall : fake,
			step: (_i, l) => steps.push(l),
			log: (l) => steps.push(l),
		});
		const img = await driver.ensureImage({ image });
		const t0 = performance.now();
		const box = await linked.create({
			image: img,
			name: `mm-it-link-${process.pid}`,
			labels: {
				[BOX_LABEL.runner]: runnerId,
				[BOX_LABEL.item]: "mm-it-link",
				[BOX_LABEL.execution]: `it-link-${process.pid}`,
			},
			env: BOX_ENV,
		});
		const link = (box as unknown as { paseoLink: PaseoLink }).paseoLink;
		await link.start();
		const tReady = performance.now() - t0;
		expect(steps.join("\n")).toContain(
			"watch in Paseo: host mastermind:mm-it-link",
		);

		// Bytes through the socket reach the box daemon's HTTP API.
		const t1 = performance.now();
		const res = await fetch("http://localhost/api/status", {
			unix: link.socketPath,
		} as RequestInit);
		expect(res.status).toBeLessThan(500);
		await res.text();
		const tStatus = performance.now() - t1;

		let tOnline = 0;
		if (real) {
			const t2 = performance.now();
			let row: Awaited<ReturnType<typeof hosts>>[number] | undefined;
			for (let i = 0; i < 60; i++) {
				row = (await hosts()).find(
					(h) => h.metadata?.[LINK_META.runner] === runnerId,
				);
				if (row?.status === "online") break;
				await Bun.sleep(500);
			}
			expect(row?.status).toBe("online");
			tOnline = performance.now() - t2;
		}
		console.log(
			`paseo link: daemon ready + socket ${Math.round(tReady)} ms, /api/status via relay ${Math.round(tStatus)} ms${real ? `, host online ${Math.round(tOnline)} ms` : ""}`,
		);

		await box.destroy();
		if (real)
			expect(
				(await hosts()).filter(
					(h) => h.metadata?.[LINK_META.runner] === runnerId,
				),
			).toEqual([]);
	}, 300_000);
});
