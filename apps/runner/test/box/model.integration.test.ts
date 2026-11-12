/**
 * The model credential stays out of the box (bead mm-210.70): a real Claude
 * task in the default box image, once on the open network and once behind an
 * allow list WITHOUT api.anthropic.com. Before each box is deleted the test
 * reads, from outside: the env and argv of every process in the box
 * (/proc/<pid>/environ, cmdline), every file the box wrote (the engine's
 * change list) and the proxy box log. None may hold the token; the box holds
 * the placeholder.
 *
 * Runs only with MM_BOX_DOCKER_HOST, MM_BOX_CLAUDE=1 and
 * CLAUDE_CODE_OAUTH_TOKEN (never printed). It uses the model quota of that
 * token (two short prompts).
 *
 *   podman system service --time=0 unix://$XDG_RUNTIME_DIR/mm-box.sock &
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock MM_BOX_CLAUDE=1 \
 *     bun test test/box/model.integration
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentNetwork } from "@mastermind/core";
import { DockerDriver } from "../../src/box/docker.ts";
import { BOX_LABEL, type Box, type BoxDriver } from "../../src/box/driver.ts";
import { DEFAULT_BOX_IMAGE } from "../../src/box/image.ts";
import { MODEL_PLACEHOLDER, MODEL_READY } from "../../src/box/proxy.ts";
import { runInBox, sweepBoxes } from "../../src/box/run.ts";
import { untar } from "../../src/box/tar.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const on = !!host && process.env.MM_BOX_CLAUDE === "1" && token.length > 20;
const image = process.env.MM_BOX_TEST_IMAGE || DEFAULT_BOX_IMAGE;
const runnerId = `it-model-${process.pid}`;
const out = mkdtempSync(join(tmpdir(), "mm-box-model-"));
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });

afterAll(async () => {
	rmSync(out, { recursive: true, force: true });
	if (on) await sweepBoxes(driver, runnerId).catch(() => {});
});

type Seen = {
	procs: string;
	files: { name: string; data: Uint8Array }[];
	proxyLog: string;
};

/** What the box holds, read from outside just before it is deleted. */
async function inspect(b: Box): Promise<Seen> {
	const p = await b.exec(
		[
			"sh",
			"-c",
			"for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat $f; echo; done 2>/dev/null | tr '\\0' '\\n'",
		],
		{ user: "root", workdir: "/" },
	);
	const changes = (await (
		await driver.request("GET", `/containers/${b.id}/changes`)
	).json()) as { Path: string; Kind: number }[] | null;
	// Changed or added paths; the top ones only (a directory brings its files).
	const paths = (changes ?? [])
		.filter((c) => c.Kind !== 2)
		.map((c) => c.Path)
		.sort();
	const top = paths.filter(
		(x, i) => !paths.slice(0, i).some((y) => x.startsWith(`${y}/`)),
	);
	const files: Seen["files"] = [];
	for (const x of top)
		files.push(
			...untar(await b.copyOut(x)).map((f) => ({
				...f,
				name: `${x}:${f.name}`,
			})),
		);
	const proxy = (b as unknown as { extra: string[] }).extra[0] ?? "";
	return {
		procs: p.stdout,
		files,
		proxyLog: proxy ? await driver.logsOf(proxy, 1000) : "",
	};
}

/** The driver, with an inspection of each box before its delete. */
function inspecting(seen: Seen[]): BoxDriver {
	return {
		name: driver.name,
		ping: () => driver.ping(),
		ensureImage: (r) => driver.ensureImage(r),
		list: (l) => driver.list(l),
		remove: (id) => driver.remove(id),
		create: async (spec) => {
			const b = await driver.create(spec);
			return new Proxy(b, {
				get(t, k) {
					if (k === "destroy")
						return async () => {
							seen.push(await inspect(t));
							await t.destroy();
						};
					const v = Reflect.get(t, k, t);
					return typeof v === "function" ? v.bind(t) : v;
				},
			});
		},
	};
}

describe.skipIf(!on)("model credential outside the box", () => {
	const cases: [string, EnvironmentNetwork][] = [
		["open network", "open"],
		["allow list without api.anthropic.com", { allow: ["example.com"] }],
	];
	for (const [what, network] of cases)
		test(`${what}: Claude Code completes a task; the box holds only the placeholder`, async () => {
			const steps: string[] = [];
			const seen: Seen[] = [];
			const res = await runInBox(
				{
					executionId: `it-model-${Date.now()}`,
					beadId: "mm-it-model",
					runnerId,
					title: "box model proxy probe",
					prompt:
						"Create the file HELLO.md in the current directory with exactly one line: hello from the box. Do not commit. Then report done.",
					env: {
						repo: "https://github.com/octocat/Hello-World.git",
						ref: "master",
						requires: [],
						image: "",
						secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
						limits: { cpu: 2, memoryMb: 2048, timeoutMin: 10 },
						network,
					},
					agent: { provider: "claude" },
					secrets: { CLAUDE_CODE_OAUTH_TOKEN: token },
				},
				{
					driver: inspecting(seen),
					defaultImage: image,
					outDir: out,
					onStep: (l) => steps.push(l),
				},
				new AbortController().signal,
			);
			console.log(`${what}\n${steps.join("\n")}\n${res.summary}`);
			expect(res.status).toBe("done");
			const patch = readFileSync(res.patch ?? "", "utf8");
			expect(patch).toContain("hello from the box");
			expect(steps.join("\n")).toContain(
				"CLAUDE_CODE_OAUTH_TOKEN: stays outside the box",
			);

			expect(seen.length).toBe(1);
			const s = seen[0] as Seen;
			// env and argv of every process: the placeholder, never the token
			expect(s.procs).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${MODEL_PLACEHOLDER}`);
			expect(s.procs).toMatch(/ANTHROPIC_BASE_URL=http:\/\/[\d.]+:3129\//);
			expect(s.procs.includes(token)).toBe(false);
			// every file the box wrote (Claude Code's and Paseo's state too)
			expect(s.files.length).toBeGreaterThan(0);
			const tok = new TextEncoder().encode(token);
			const leaks = s.files
				.filter((f) => Buffer.from(f.data).indexOf(tok) >= 0)
				.map((f) => f.name);
			expect(leaks).toEqual([]);
			// the proxy served the route and logged no value
			expect(s.proxyLog).toContain(MODEL_READY);
			expect(s.proxyLog.includes(token)).toBe(false);
			console.log(
				`checked ${s.files.length} files the box wrote, ${s.procs.split("\n").length} env/argv lines; proxy log:\n${s.proxyLog.trim().split("\n").slice(-5).join("\n")}`,
			);
			expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
		}, 900_000);
});
