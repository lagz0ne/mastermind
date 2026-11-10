// Test helper: a NATS for tests. NATS_TEST_URL (a running server) wins;
// else NATS_SERVER (or nats-server on PATH) starts a throwaway one on
// 127.0.0.1. Null when neither exists: the caller skips its NATS tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestNats = { url: string; stop(): void };

export function natsAvailable(): boolean {
	return Boolean(
		process.env.NATS_TEST_URL ||
			process.env.NATS_SERVER ||
			Bun.which("nats-server"),
	);
}

export async function testNats(): Promise<TestNats> {
	const url = process.env.NATS_TEST_URL;
	if (url) return { url, stop() {} };
	const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
	if (!bin) throw new Error("no NATS_TEST_URL, NATS_SERVER or nats-server");
	const dir = mkdtempSync(join(tmpdir(), "mm-work-nats-"));
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const conf = `host: 127.0.0.1
port: ${base}
http: "127.0.0.1:${base + 1}"
jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }
websocket { host: 127.0.0.1, port: ${base + 2}, no_tls: true }
`;
	await Bun.write(join(dir, "nats.conf"), conf);
	const proc = Bun.spawn([bin, "-c", join(dir, "nats.conf")], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const stop = () => {
		proc.kill();
		rmSync(dir, { recursive: true, force: true });
	};
	for (let i = 0; i < 50; i++) {
		const r = await fetch(`http://127.0.0.1:${base + 1}/healthz`).catch(
			() => undefined,
		);
		if (r?.ok) return { url: `ws://127.0.0.1:${base + 2}`, stop };
		await Bun.sleep(100);
	}
	stop();
	throw new Error("nats-server did not start");
}
