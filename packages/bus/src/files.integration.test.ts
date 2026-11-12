/**
 * Files against a real nats-server: NATS_TEST_URL (a running server), or
 * NATS_SERVER (a nats-server binary; this file starts a throwaway one).
 * Skipped when neither is set (CI).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { BusError } from "./codec.ts";
import { connect } from "./connect.ts";
import { accountFilesBucket, Files } from "./files.ts";

const bin = process.env.NATS_SERVER;
const given = process.env.NATS_TEST_URL;

async function startServer(): Promise<{ url: string; stop(): void }> {
	if (given) return { url: given, stop() {} };
	const dir = mkdtempSync(join(tmpdir(), "mm-bus-files-"));
	await Bun.write(
		join(dir, "nats.conf"),
		`host: 127.0.0.1\nport: -1\nports_file_dir: ${JSON.stringify(dir)}\njetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }\nwebsocket { host: 127.0.0.1, port: -1, no_tls: true }\n`,
	);
	const proc = Bun.spawn([bin as string, "-c", join(dir, "nats.conf")], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const stop = () => {
		proc.kill();
		rmSync(dir, { recursive: true, force: true });
	};
	for (let i = 0; i < 100; i++) {
		const f = readdirSync(dir).find((n) => n.endsWith(".ports"));
		const ports = f
			? ((await Bun.file(join(dir, f))
					.json()
					.catch(() => null)) as { websocket?: string[] } | null)
			: null;
		const ws = ports?.websocket?.[0];
		if (ws) return { url: ws, stop };
		await Bun.sleep(100);
	}
	stop();
	throw new Error("nats-server did not start");
}

/** `size` bytes of a repeating pattern, made in 1 MiB pieces as they are read. */
function pattern(size: number): ReadableStream<Uint8Array> {
	const piece = new Uint8Array(1024 * 1024).map((_, i) => (i * 31) % 251);
	let left = size;
	return new ReadableStream({
		pull(ctl) {
			if (left <= 0) return ctl.close();
			const n = Math.min(left, piece.length);
			left -= n;
			ctl.enqueue(piece.slice(0, n));
		},
	});
}

async function sha256Of(s: ReadableStream<Uint8Array>) {
	const h = new Bun.CryptoHasher("sha256");
	let size = 0;
	for await (const c of s) {
		h.update(c);
		size += c.byteLength;
	}
	return { sha256: h.digest("hex"), size };
}

describe.skipIf(!bin && !given)("files against nats-server", () => {
	let server: { url: string; stop(): void };
	let nc: NatsConnection;
	let files: Files;
	const bucket = accountFilesBucket(`t${Date.now().toString(36)}`);

	beforeAll(async () => {
		server = await startServer();
		nc = await connect({ servers: server.url, name: "bus-files-test" });
		files = await Files.open(nc, bucket, {
			create: true,
			maxObjectBytes: 8 * 1024 * 1024,
		});
	});
	afterAll(async () => {
		await nc?.drain();
		server?.stop();
	});

	test("put, info, get (same sha256), list by prefix, delete", async () => {
		const size = 3 * 1024 * 1024 + 17;
		const want = await sha256Of(pattern(size));
		const put = await files.put("it-1/in/a.bin", pattern(size), {
			contentType: "application/octet-stream",
			size,
			sha256: want.sha256,
		});
		expect(put).toMatchObject({ name: "it-1/in/a.bin", ...want });
		await files.put("it-1/out/log.txt", new Blob(["hello"]).stream());
		await files.put("it-2/in/b.txt", new Blob(["x"]).stream());

		expect(await files.info("it-1/in/a.bin")).toMatchObject({
			size,
			contentType: "application/octet-stream",
		});
		const got = await files.get("it-1/in/a.bin");
		expect(got && (await sha256Of(got.data))).toEqual(want);

		expect((await files.list("it-1/")).map((f) => f.name)).toEqual([
			"it-1/in/a.bin",
			"it-1/out/log.txt",
		]);
		expect(await files.usage()).toEqual({ files: 3, bytes: size + 6 });

		expect(await files.delete("it-1/in/a.bin")).toBe(true);
		expect(await files.delete("it-1/in/a.bin")).toBe(false);
		expect(await files.get("it-1/in/a.bin")).toBeNull();
		expect((await files.list("it-1/")).map((f) => f.name)).toEqual([
			"it-1/out/log.txt",
		]);
	});

	test("a put over the limit, or with a wrong size or sha256, leaves nothing", async () => {
		const tooBig = files.put("it-3/in/big", pattern(9 * 1024 * 1024));
		expect(tooBig).rejects.toBeInstanceOf(BusError);
		await tooBig.catch(() => {});
		expect(await files.info("it-3/in/big")).toBeNull();

		const wrongSize = files.put("it-3/in/s", new Blob(["abc"]).stream(), {
			size: 4,
		});
		expect(wrongSize).rejects.toThrow(/size 3, expected 4/);
		await wrongSize.catch(() => {});
		const wrongSha = files.put("it-3/in/h", new Blob(["abc"]).stream(), {
			sha256: "00",
		});
		expect(wrongSha).rejects.toThrow(/sha256/);
		await wrongSha.catch(() => {});
		expect(await files.list("it-3/")).toEqual([]);
	});

	test("copyTo streams into another bucket; open without create needs the bucket", async () => {
		const other = await Files.open(nc, `${bucket}_b`, { create: true });
		await files.put("it-4/in/c.txt", new Blob(["copy me"]).stream(), {
			contentType: "text/plain",
		});
		const copied = await files.copyTo("it-4/in/c.txt", other);
		expect(copied).toMatchObject({ size: 7, contentType: "text/plain" });
		const got = await other.get("it-4/in/c.txt");
		expect(got && (await new Response(got.data).text())).toBe("copy me");
		expect(await files.copyTo("it-4/in/none", other)).toBeNull();

		expect(Files.open(nc, `${bucket}_missing`)).rejects.toMatchObject({
			code: "not_found",
		});
	});

	test("an empty file round-trips", async () => {
		await files.put("it-5/out/empty", new Blob([]).stream());
		const got = await files.get("it-5/out/empty");
		expect(got?.info.size).toBe(0);
		expect(got && (await new Response(got.data).text())).toBe("");
	});
});
