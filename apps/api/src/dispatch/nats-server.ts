// Test helper: a throwaway nats-server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type NatsServer = { url: string; stop(): void };

/** A throwaway nats-server with WebSocket and JetStream on random ports. */
export async function startNats(path: string): Promise<NatsServer> {
	const dir = mkdtempSync(join(tmpdir(), "mm-dispatch-nats-"));
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const conf = `port: ${base}
http: ${base + 1}
jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }
websocket { port: ${base + 2}, no_tls: true }
`;
	await Bun.write(join(dir, "nats.conf"), conf);
	const proc = Bun.spawn([path, "-c", join(dir, "nats.conf")], {
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
