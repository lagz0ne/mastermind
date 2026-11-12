// The test nats-server picks its own free ports (mm-ut1). Needs the binary:
// NATS_SERVER=/path/to/nats-server; skips without one.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { freePortsConf, startNatsServer } from "./nats-server.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

test.skipIf(!bin)(
	"servers started at once get their own ports and answer on WebSocket",
	async () => {
		const path = bin as string;
		const servers = await Promise.all(
			[1, 2, 3].map(() => startNatsServer(path)),
		);
		try {
			const urls = servers.map((s) => s.url);
			expect(new Set(urls).size).toBe(3);
			for (const url of urls) {
				expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
				const info = await new Promise<string>((resolve, reject) => {
					const ws = new WebSocket(url);
					ws.onmessage = (e) => {
						resolve(String(e.data));
						ws.close();
					};
					ws.onerror = () => reject(new Error(`no answer on ${url}`));
				});
				expect(info).toStartWith("INFO ");
			}
		} finally {
			for (const s of servers) s.stop();
		}
	},
);

test("a binary that is not nats-server fails fast and says so", async () => {
	const start = performance.now();
	await expect(startNatsServer("/bin/false")).rejects.toThrow(
		/exited with code 1/,
	);
	expect(performance.now() - start).toBeLessThan(2_000);
});

test("freePortsConf: the deploy config gets free ports, the ports file and a local store", async () => {
	const deploy = await Bun.file(
		join(import.meta.dir, "../../../deploy/nats/nats.conf"),
	).text();
	const ports = { client: 4222, http: 8222, websocket: 8080 };
	const conf = freePortsConf(deploy, "/tmp/x", ports);
	expect(conf).not.toMatch(/^\s*(port|http): \d/m);
	expect(conf.match(/port: -1/g)?.length).toBe(2);
	expect(conf).toContain('http: "127.0.0.1:-1"');
	expect(conf).toContain('ports_file_dir: "/tmp/x"');
	expect(conf).toContain('store_dir: "/tmp/x/js"');
	expect(conf).not.toContain("/data/jetstream");
	// A changed deploy port fails loudly instead of binding the fixed one.
	expect(() =>
		freePortsConf(deploy, "/tmp/x", { ...ports, http: 9999 }),
	).toThrow(/http: 9999/);
});
