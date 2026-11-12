/**
 * Item files through a real box (mm-210.60): a 50 MiB input appears at
 * INPUTS_DIR with the same sha256, and an artifact the agent makes in
 * OUTPUTS_DIR comes out with the same sha256. Streams both ways.
 * Runs only with MM_BOX_DOCKER_HOST (see docker.integration.test.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { FileInfo } from "@mastermind/bus";
import { INPUTS_DIR, OUTPUTS_DIR } from "@mastermind/core";
import { DockerDriver } from "../../src/box/docker.ts";
import type { BoxFiles } from "../../src/box/files.ts";
import { runInBox, sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-files-${process.pid}`;
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });
const MiB = 1024 * 1024;

afterAll(async () => {
	if (host) await sweepBoxes(driver, runnerId).catch(() => {});
});

function pattern(size: number): ReadableStream<Uint8Array> {
	const piece = new Uint8Array(MiB).map((_, i) => (i * 7) % 251);
	let left = size;
	return new ReadableStream({
		pull(c) {
			if (left <= 0) return c.close();
			const n = Math.min(left, MiB);
			left -= n;
			c.enqueue(piece.slice(0, n));
		},
	});
}

async function sha256Of(s: ReadableStream<Uint8Array>) {
	const h = new Bun.CryptoHasher("sha256");
	for await (const c of s) h.update(c);
	return h.digest("hex");
}

describe.skipIf(!host)("item files in a real box", () => {
	test("50 MiB in at INPUTS_DIR, an artifact out, same sha256 both ways", async () => {
		const size = 50 * MiB;
		const inSha = await sha256Of(pattern(size));
		const written: Record<string, string> = {};
		const io: BoxFiles = {
			stage: async () => [
				{ name: "big.bin", dir: "in", size, sha256: inSha, mtime: "" },
			],
			read: async () => ({ size, data: pattern(size) }),
			write: async (_b, name, data) => {
				written[name] = await sha256Of(data);
				return { name } as FileInfo;
			},
			out: async () => [],
		};
		const agent = [
			`sha256sum ${INPUTS_DIR}/big.bin | cut -d' ' -f1 > ${OUTPUTS_DIR}/in.sha`,
			`head -c 3000001 /dev/urandom > ${OUTPUTS_DIR}/art.bin`,
			`echo "{\\"status\\":\\"done\\",\\"summary\\":\\"$(sha256sum ${OUTPUTS_DIR}/art.bin | cut -d' ' -f1)\\"}"`,
		].join(" && ");
		const steps: string[] = [];
		const res = await runInBox(
			{
				executionId: `it-files-${Date.now()}`,
				beadId: "mm-it",
				runnerId,
				title: "files",
				prompt: "use the files",
				// No repo: no clone (repo "" is falsy in runInBox).
				env: { repo: "", ref: "", requires: [], image, network: "open" },
				agent: {},
				secrets: {},
			},
			{
				driver,
				defaultImage: image,
				agentCommand: () => ["sh", "-c", agent],
				readyCommand: null,
				files: () => io,
				onStep: (l) => steps.push(l),
			},
			new AbortController().signal,
		);
		console.log(steps.join("\n"));
		expect(res.status).toBe("done");
		expect(steps).toContain(`files in: big.bin (50 MiB) at ${INPUTS_DIR}`);
		// The box computed the input's sha256; it went out as in.sha.
		expect(written["art.bin"]).toBe(res.summary.trim());
		expect(Object.keys(written).sort()).toEqual([
			"agent.log",
			"art.bin",
			"in.sha",
		]);
		const box = (await driver.list({})).filter((b) =>
			b.name.includes("it-files"),
		);
		expect(box).toEqual([]);
		// in.sha's content is the input's sha256 (checked through its own hash).
		expect(written["in.sha"]).toBe(
			new Bun.CryptoHasher("sha256").update(`${inSha}\n`).digest("hex"),
		);
	}, 180_000);
});
