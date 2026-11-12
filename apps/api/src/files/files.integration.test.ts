// Files of an item end to end against a real nats-server (mm-210.60): HTTP
// upload and download, stage and out over NATS, and the api's memory during a
// big upload. Needs NATS_TEST_URL or NATS_SERVER; skips without (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	accountFilesBucket,
	connect,
	Files,
	request,
	subjects,
} from "@mastermind/bus";
import type { Bead, ItemFilesReply } from "@mastermind/core";
import { NotFound } from "@mastermind/work";
import { natsAvailable, type TestNats, testNats } from "@mastermind/work/test";
import type { NatsConnection } from "@nats-io/nats-core";
import { filesRoutes } from "./routes.ts";
import type { OutReply, StageReply } from "./serve.ts";
import { filesConfigFromEnv } from "./service.ts";
import { startFilesInBackground } from "./start.ts";

const MiB = 1024 * 1024;

/** `size` bytes made in 1 MiB pieces as they are read. */
function pattern(size: number, seed = 7): ReadableStream<Uint8Array> {
	const piece = new Uint8Array(MiB).map((_, i) => (i * seed) % 251);
	let left = size;
	return new ReadableStream({
		pull(ctl) {
			if (left <= 0) return ctl.close();
			const n = Math.min(left, MiB);
			left -= n;
			ctl.enqueue(n === MiB ? piece : piece.slice(0, n));
		},
	});
}

async function sha256Of(s: ReadableStream<Uint8Array>) {
	const h = new Bun.CryptoHasher("sha256");
	for await (const c of s) h.update(c);
	return h.digest("hex");
}

describe.skipIf(!natsAvailable())("item files against nats-server", () => {
	let nats: TestNats;
	let nc: NatsConnection;
	let runner: NatsConnection;
	let server: ReturnType<typeof Bun.serve>;
	let bg: ReturnType<typeof startFilesInBackground>;
	const id = `it-${Date.now().toString(36)}.1`;
	const bead = {
		id,
		title: "t",
		status: "in_progress",
		assignee: "alice/laptop",
	} as Bead;
	const comments: string[] = [];
	const beads = {
		get: async (want: string) => {
			if (want !== id)
				throw new NotFound({
					status: 404,
					title: "not found",
					code: "not_found",
				});
			return bead;
		},
		comment: async (_id: string, actor: string, text: string) => {
			comments.push(`${actor}: ${text}`);
			return {} as never;
		},
	};

	beforeAll(async () => {
		nats = await testNats();
		nc = await connect({ servers: nats.url, name: "files-test-api" });
		runner = await connect({ servers: nats.url, name: "files-test-runner" });
		bg = startFilesInBackground(
			{ connection: Promise.resolve(nc) },
			beads,
			{ ...filesConfigFromEnv({}), maxObjectBytes: 256 * MiB },
			{ log: () => {} },
		);
		for (let i = 0; i < 100 && !bg.files(); i++) await Bun.sleep(50);
		const routes = filesRoutes({
			files: bg.files,
			beads,
			requireAccount: async () => "bob",
		});
		server = Bun.serve({ port: 0, routes, maxRequestBodySize: 1024 * MiB });
	});
	afterAll(async () => {
		await server?.stop(true);
		await bg?.stop();
		await Promise.all([nc?.drain(), runner?.drain()]);
		nats?.stop();
	});

	const url = (path: string) =>
		`${server.url.origin}/api/items/${encodeURIComponent(id)}/files${path}`;

	test("a 50 MiB input reaches the runner's bucket; an output comes back with the same sha256", async () => {
		const size = 50 * MiB;
		const want = await sha256Of(pattern(size));
		const up = await fetch(url("?name=data.bin"), {
			method: "POST",
			body: pattern(size),
			headers: {
				"content-type": "application/octet-stream",
				"x-sha256": want,
			},
		});
		expect(up.status).toBe(201);
		expect(await up.json()).toMatchObject({
			name: "data.bin",
			dir: "in",
			size,
			sha256: want,
		});
		expect(comments).toContain("bob: file in: data.bin (50 MiB)");

		// The runner of alice (the claim holder) stages the inputs, then reads its own bucket.
		const staged = await request<object, StageReply>(
			runner,
			subjects.files("alice", id, "stage"),
			{},
			{ timeout: 30_000 },
		);
		expect(staged.inputs).toEqual([
			expect.objectContaining({ name: "data.bin", size, sha256: want }),
		]);
		const own = await Files.open(runner, accountFilesBucket("alice"));
		const got = await own.get(`${id}/in/data.bin`);
		expect(got && (await sha256Of(got.data))).toBe(want);

		// Another account may not stage it.
		await expect(
			request(runner, subjects.files("bob", id, "stage"), {}),
		).rejects.toMatchObject({ code: "forbidden" });

		// An artifact made in the box goes out and is downloadable from the ticket.
		const patch = "diff --git a/x b/x\n+hello\n";
		await own.put(`${id}/out/patch.diff`, new Blob([patch]).stream(), {
			contentType: "text/x-diff",
		});
		const out = await request<{ names: string[] }, OutReply>(
			runner,
			subjects.files("alice", id, "out"),
			{ names: ["patch.diff", "missing.txt"] },
		);
		expect(out.outputs.map((f) => f.name)).toEqual(["patch.diff"]);
		expect(comments).toContain("alice/laptop: file out: patch.diff (26 B)");

		const list = (await (await fetch(url(""))).json()) as ItemFilesReply;
		expect(list.inputs.map((f) => [f.name, f.size])).toEqual([
			["data.bin", size],
		]);
		expect(list.outputs.map((f) => f.name)).toEqual(["patch.diff"]);
		expect(list.maxBytes).toBe(256 * MiB);

		const dl = await fetch(url("/out/patch.diff"));
		expect(dl.status).toBe(200);
		expect(dl.headers.get("content-disposition")).toContain("patch.diff");
		expect(dl.headers.get("content-security-policy")).toBe("sandbox");
		expect(dl.headers.get("content-type")).toBe("text/x-diff");
		expect(await dl.text()).toBe(patch);

		const big = await fetch(url("/in/data.bin"));
		expect(big.headers.get("x-file-size")).toBe(String(size));
		expect(await sha256Of(big.body as ReadableStream<Uint8Array>)).toBe(want);

		// Inputs can be deleted; the next stage removes the runner's copy.
		expect(
			(await fetch(url("/in/data.bin"), { method: "DELETE" })).status,
		).toBe(204);
		expect(
			(await fetch(url("/out/patch.diff"), { method: "DELETE" })).status,
		).toBe(400);
		await request(runner, subjects.files("alice", id, "stage"), {});
		expect(await own.info(`${id}/in/data.bin`)).toBeNull();
	}, 60_000);

	test("bad requests: no item, no name, over the limit, wrong sha256", async () => {
		const other = `${server.url.origin}/api/items/nope/files`;
		expect((await fetch(other)).status).toBe(404);
		expect((await fetch(url(""), { method: "POST", body: "x" })).status).toBe(
			400,
		);
		const tooBig = await fetch(url("?name=big"), {
			method: "POST",
			body: new Uint8Array(257 * MiB),
		});
		expect(tooBig.status).toBe(413);
		const wrong = await fetch(url("?name=w.txt"), {
			method: "POST",
			body: "abc",
			headers: { "x-sha256": "0".repeat(64) },
		});
		expect(wrong.status).toBe(400);
		expect((await fetch(url("/in/w.txt"))).status).toBe(404);
	}, 30_000);

	test("the api's memory stays flat during a 200 MiB upload", async () => {
		const size = 200 * MiB;
		// Warm up first (JIT, sockets, buffers): growth after that is the upload's.
		const warm = await fetch(url("?name=warm.bin"), {
			method: "POST",
			body: pattern(20 * MiB, 11),
		});
		expect(warm.status).toBe(201);
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		let peak = before;
		const timer = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss);
		}, 20);
		const up = await fetch(url("?name=huge.bin"), {
			method: "POST",
			body: pattern(size, 13),
		});
		clearInterval(timer);
		expect(up.status).toBe(201);
		expect(((await up.json()) as { size: number }).size).toBe(size);
		// Buffering would grow by >= 200 MiB. Measured: about 65 MiB for both 200
		// and 250 MiB uploads (client and server in this one process).
		expect(peak - before).toBeLessThan(size / 2);
	}, 120_000);
});
