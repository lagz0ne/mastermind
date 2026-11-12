import { describe, expect, test } from "bun:test";
import type { FileInfo } from "@mastermind/bus";
import { INPUTS_DIR, OUTPUTS_DIR } from "@mastermind/core";
import type { BoxFiles } from "../../src/box/files.ts";
import { type BoxTask, runInBox } from "../../src/box/run.ts";
import { tar, tarStream, untar, untarFirst } from "../../src/box/tar.ts";
import { FakeDriver } from "./fake-driver.ts";

const never = new AbortController().signal;

function task(): BoxTask {
	return {
		executionId: "mm-9-1",
		beadId: "mm-9",
		runnerId: "laptop",
		title: "mm-9: use the data",
		prompt: "summarize data.csv",
		env: {
			name: "web",
			repo: "https://github.com/acme/web.git",
			ref: "main",
			requires: [],
			image: "",
			tools: [],
			network: "open",
		},
		agent: { provider: "claude" },
		secrets: {},
	};
}

class FakeFiles implements BoxFiles {
	written: { name: string; text: string; size?: number }[] = [];
	outs: string[][] = [];
	stageError: Error | null = null;
	async stage() {
		if (this.stageError) throw this.stageError;
		return [
			{
				name: "data.csv",
				dir: "in" as const,
				size: 5,
				sha256: "x",
				mtime: "",
			},
		];
	}
	async read(_bead: string, name: string) {
		return name === "data.csv"
			? { size: 5, data: new Blob(["a,b\n1"]).stream() }
			: null;
	}
	async write(
		_bead: string,
		name: string,
		data: ReadableStream<Uint8Array>,
		meta: { size?: number } = {},
	) {
		this.written.push({
			name,
			text: await new Response(data).text(),
			...(meta.size !== undefined ? { size: meta.size } : {}),
		});
		return { name } as FileInfo;
	}
	async out(_bead: string, names: string[]) {
		this.outs.push(names);
		return [];
	}
}

describe("box files (mm-210.60)", () => {
	test("inputs go into the box before the agent; outputs, patch and log come out", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "sh" && cmd[3] === "list"
				? { code: 0, stdout: "report.md\nbad name?\nagent.log\n", stderr: "" }
				: undefined;
		const io = new FakeFiles();
		const steps: string[] = [];
		const res = await runInBox(
			task(),
			{
				driver: d,
				defaultImage: "img",
				files: () => io,
				onStep: (l) => steps.push(l),
			},
			never,
		);
		expect(res.status).toBe("done");
		expect(d.copiedIn).toContainEqual({
			box: "box1",
			dir: INPUTS_DIR,
			names: ["data.csv"],
		});
		const lines = d.execs.map((e) => e.cmd.join(" "));
		// Inputs and outputs never end up in the patch or the pushed branch.
		expect(lines).toContain(
			"sh -c printf '.mastermind/\\n' >> .git/info/exclude",
		);
		expect(lines).toContain(`mkdir -p ${INPUTS_DIR} ${OUTPUTS_DIR}`);
		const run = d.execs.find((e) => e.cmd[0] === "paseo" && e.cmd[1] === "run");
		const prompt = run?.cmd.at(-1) ?? "";
		expect(prompt).toStartWith("summarize data.csv\n\n");
		expect(prompt).toContain(`${INPUTS_DIR}: data.csv.`);
		expect(prompt).toContain(OUTPUTS_DIR);

		// The fake box gives the patch text for every path it is asked for.
		expect(io.written.map((w) => w.name)).toEqual([
			"changes.patch",
			"report.md",
			"agent.log",
		]);
		expect(io.written[0]?.text).toBe(d.patch);
		expect(io.written[2]?.text).toContain('"status":"done"');
		expect(io.outs).toEqual([["changes.patch", "report.md", "agent.log"]]);
		expect(steps).toContain(`files in: data.csv (5 B) at ${INPUTS_DIR}`);
		expect(steps.find((s) => s.startsWith("files out: "))).toContain(
			"report.md",
		);
	});

	test("no files provider: nothing changes", async () => {
		const d = new FakeDriver();
		await runInBox(task(), { driver: d, defaultImage: "img" }, never);
		const run = d.execs.find((e) => e.cmd[0] === "paseo" && e.cmd[1] === "run");
		expect(run?.cmd.at(-1)).toBe("summarize data.csv");
		expect(d.copiedIn.some((c) => c.dir === INPUTS_DIR)).toBe(false);
	});

	test("inputs that cannot be staged stop the task before the agent starts", async () => {
		const d = new FakeDriver();
		const io = new FakeFiles();
		io.stageError = new Error("mastermind is not answering");
		await expect(
			runInBox(
				task(),
				{ driver: d, defaultImage: "img", files: () => io },
				never,
			),
		).rejects.toThrow("files in: mastermind is not answering");
		expect(
			d.execs.some((e) => e.cmd[0] === "paseo" && e.cmd[1] === "run"),
		).toBe(false);
		expect(d.boxes.size).toBe(0);
	});
});

describe("tar streams", () => {
	const bytes = (n: number) => new Uint8Array(n).map((_, i) => i % 251);

	test("tarStream is a tar that untar reads", async () => {
		for (const size of [0, 1, 511, 512, 513, 200_000]) {
			const data = bytes(size);
			const archive = new Uint8Array(
				await new Response(
					tarStream({ name: "a.bin", size, data: new Blob([data]).stream() }),
				).arrayBuffer(),
			);
			expect(archive.length % 512).toBe(0);
			const [f] = untar(archive);
			expect(f?.name).toBe("a.bin");
			expect(f?.data).toEqual(data);
		}
	});

	test("tarStream errors when the size is wrong", async () => {
		const short = tarStream({
			name: "a",
			size: 10,
			data: new Blob(["abc"]).stream(),
		});
		await expect(new Response(short).arrayBuffer()).rejects.toThrow(
			"3 of 10 bytes",
		);
	});

	test("untarFirst streams the first file, in small pieces", async () => {
		const data = bytes(300_000);
		const archive = tar([{ name: "x/out.bin", data }]);
		// Feed it 1000 bytes at a time.
		let at = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (at >= archive.length) return c.close();
				c.enqueue(archive.slice(at, at + 1000));
				at += 1000;
			},
		});
		const f = await untarFirst(stream);
		expect(f?.name).toBe("x/out.bin");
		expect(f?.size).toBe(300_000);
		expect(new Uint8Array(await new Response(f?.data).arrayBuffer())).toEqual(
			data,
		);
		expect(
			await untarFirst(new Blob([new Uint8Array(1024)]).stream()),
		).toBeNull();
	});
});
