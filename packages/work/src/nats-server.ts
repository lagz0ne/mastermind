// Test helper: a NATS for tests. NATS_TEST_URL (a running server) wins;
// else NATS_SERVER (or nats-server on PATH) starts a throwaway one on
// 127.0.0.1. Null when neither exists: the caller skips its NATS tests.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
	return startNatsServer(bin, { prefix: "mm-work-nats-" });
}

export type NatsServerOptions = {
	/** Prefix of the temp directory (conf, store, ports file). */
	prefix?: string;
	/**
	 * The server config, given the temp directory. It must set port -1 for
	 * client, monitoring and websocket, and `ports_file_dir` to `dir`:
	 * see {@link freePortsConf}. Default: a plain JetStream + WebSocket server.
	 */
	conf?: (dir: string) => string;
	/** Environment of the server process (config variables). */
	env?: Record<string, string>;
};

/**
 * Turn a deploy config into a test one: every port -1 (free ports), the
 * ports file and the JetStream store in `dir`, and only on 127.0.0.1.
 */
export function freePortsConf(
	conf: string,
	dir: string,
	ports: { client: number; http: number; websocket: number },
): string {
	const swap = (from: string, to: string) => {
		if (!conf.includes(from)) throw new Error(`conf has no "${from}"`);
		conf = conf.replace(from, to);
	};
	swap(`port: ${ports.client}`, "port: -1");
	swap(`http: ${ports.http}`, 'http: "127.0.0.1:-1"');
	swap(`port: ${ports.websocket}`, "port: -1");
	conf = conf.replace(
		/store_dir: "[^"]*"/,
		`store_dir: ${JSON.stringify(join(dir, "js"))}`,
	);
	return `host: 127.0.0.1\nports_file_dir: ${JSON.stringify(dir)}\n${conf}`;
}

const plainConf = (dir: string) => `host: 127.0.0.1
port: -1
http: "127.0.0.1:-1"
ports_file_dir: ${JSON.stringify(dir)}
jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }
websocket { host: 127.0.0.1, port: -1, no_tls: true }
`;

/**
 * A throwaway nats-server (JetStream, WebSocket) at `bin`. The server picks
 * free ports itself (-1) and writes them to its ports file: a port chosen at
 * random here can be taken by any socket on the machine, and then the server
 * exits (mm-ut1). The url is the WebSocket one.
 */
export async function startNatsServer(
	bin: string,
	opts: NatsServerOptions = {},
): Promise<TestNats> {
	const dir = mkdtempSync(join(tmpdir(), opts.prefix ?? "mm-nats-"));
	await Bun.write(join(dir, "nats.conf"), (opts.conf ?? plainConf)(dir));
	const proc = Bun.spawn([bin, "-c", join(dir, "nats.conf")], {
		env: opts.env,
		stdout: "ignore",
		stderr: "ignore",
	});
	const stop = () => {
		proc.kill();
		rmSync(dir, { recursive: true, force: true });
	};
	for (let i = 0; i < 100 && proc.exitCode === null; i++) {
		const ports = await readPorts(dir);
		const ws = ports?.websocket?.[0];
		const http = ports?.monitoring?.[0];
		if (ws && http) {
			const r = await fetch(`${http}/healthz`).catch(() => undefined);
			if (r?.ok) return { url: ws, stop };
		}
		await Bun.sleep(100);
	}
	const code = proc.exitCode;
	stop();
	throw new Error(
		code === null
			? "nats-server did not start in 10 s"
			: `nats-server exited with code ${code}`,
	);
}

type Ports = { websocket?: string[]; monitoring?: string[] };

/** The ports file nats-server writes once it listens (<exe>_<pid>.ports). */
async function readPorts(dir: string): Promise<Ports | undefined> {
	const name = readdirSync(dir).find((f) => f.endsWith(".ports"));
	if (!name) return undefined;
	return (await Bun.file(join(dir, name))
		.json()
		.catch(() => undefined)) as Ports | undefined;
}
