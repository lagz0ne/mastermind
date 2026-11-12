/**
 * The box agent in the user's own Paseo app (mm-210.68).
 *
 * When a box starts, the runner registers the box's Paseo daemon as a
 * CONNECTED HOST of the runner machine's own Paseo daemon (Paseo 0.13+,
 * `paseo host add`). The user sees the boxed agent live in the Paseo desktop
 * and mobile app and can steer it. When the box is deleted, the host is
 * removed (`paseo host rm`). A sweep at runner start removes the hosts that
 * an earlier run of this runner left behind (crash).
 *
 *   outer Paseo daemon --unix://<linkDir>/<execution>.sock--> runner (relay)
 *     --Docker exec stream (stdin/stdout)--> `node` bridge in the box
 *     --tcp 127.0.0.1:6767--> box Paseo daemon
 *
 * Why this transport (like `ssh -W`, a stdio tunnel): the box daemon listens
 * only inside the box (BOX_ENV) and the box may sit on an internal network
 * with no published ports (allow list, mm-210.63). A published port would
 * need a daemon password (other users of the machine reach 127.0.0.1) and
 * does not work on internal networks; a unix socket bind mount does not cross
 * the VM of Docker Desktop on macOS. The exec stream works on every engine
 * the driver supports. It is only the TRANSPORT of the Paseo connection: the
 * control path is Paseo's own protocol (the connected-hosts direction of the
 * lead, 2026-11-12). It goes away when Paseo can reach a box another way.
 *
 * No password: the box daemon has none and is reachable only through this
 * socket, in a directory only the runner's user can open (0700, socket 0600),
 * like the Docker socket and Paseo's own local socket. Nothing secret is in
 * argv or logs.
 */
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import type { DockerEndpoint } from "./docker.ts";
import { BOX_LABEL, type Box, type BoxDriver, type BoxSpec } from "./driver.ts";
import { BOX_ENV } from "./run.ts";

/** Host label prefix and metadata keys of the hosts this runner registers. */
export const LINK_LABEL_PREFIX = "mastermind:";
export const LINK_META = {
	runner: "mastermind.runner",
	item: "mastermind.item",
	execution: "mastermind.execution",
} as const;

/** The box daemon's TCP port inside the box (BOX_ENV PASEO_LISTEN). */
export function boxDaemonAddress(): { host: string; port: number } {
	const [host = "127.0.0.1", port = "6767"] = (
		BOX_ENV.PASEO_LISTEN ?? "127.0.0.1:6767"
	).split(":");
	return { host, port: Number(port) };
}

/** The stdio <-> TCP bridge run with `node -e` in the box. */
export function bridgeScript(): string {
	const { host, port } = boxDaemonAddress();
	return [
		`const s=require("net").connect(${port},${JSON.stringify(host)});`,
		"process.stdin.pipe(s);s.pipe(process.stdout);",
		's.on("close",()=>process.exit(0));s.on("error",()=>process.exit(1));',
	].join("");
}

/** A byte stream into the box: what the relay needs from the engine. */
export type OpenStream = (boxId: string) => Promise<Duplex>;

/** Result of one `paseo` CLI call on this machine. */
export type PaseoCall = (
	args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `paseo <args>` against the local Paseo home (never with a secret in argv). */
export const paseoCall: PaseoCall = async (args) => {
	try {
		const p = Bun.spawn(["paseo", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timer = setTimeout(() => p.kill(), 20_000);
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		clearTimeout(timer);
		return { code, stdout, stderr };
	} catch (error) {
		return {
			code: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
};

export type PaseoLinkOptions = {
	/** Directory of the relay sockets; made 0700. Keep the path short (unix: ~100 bytes). */
	dir: string;
	runnerId: string;
	/** A byte stream to the bridge in a box (default: Docker exec, {@link dockerExecStream}). */
	open: OpenStream;
	paseo?: PaseoCall;
	/** Is the box daemon up? Default: HTTP {@link daemonAnswers}, then `paseo ls` through the relay. */
	ready?: (box: Box) => Promise<boolean>;
	/** How long the box daemon may take to start. Default 120 s. */
	readyTimeoutMs?: number;
	/** A line for the item's ticket. */
	step?: (item: string, line: string) => void;
	log?: (line: string) => void;
};

type HostRow = {
	registrationId: string;
	label?: string | null;
	metadata?: Record<string, string>;
};

function firstLine(s: string): string {
	return s.trim().split("\n")[0]?.slice(0, 300) ?? "";
}

/** The hosts this runner registered (by metadata), from `paseo host ls`. */
async function ownHosts(
	paseo: PaseoCall,
	runnerId: string,
): Promise<HostRow[]> {
	const r = await paseo(["host", "ls", "--json"]);
	if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout));
	const rows = JSON.parse(r.stdout || "[]") as HostRow[];
	return rows.filter((h) => h.metadata?.[LINK_META.runner] === runnerId);
}

/**
 * Runner start: remove the hosts and sockets an earlier run of this runner
 * left behind. Returns the removed registration ids. Never throws.
 */
export async function sweepPaseoLinks(
	o: Pick<PaseoLinkOptions, "dir" | "runnerId" | "paseo" | "log">,
): Promise<string[]> {
	const paseo = o.paseo ?? paseoCall;
	const log = o.log ?? (() => {});
	const gone: string[] = [];
	try {
		for (const h of await ownHosts(paseo, o.runnerId)) {
			const r = await paseo(["host", "rm", h.registrationId, "--json"]);
			if (r.code === 0) gone.push(h.registrationId);
		}
	} catch (error) {
		log(
			`paseo link: cannot list Paseo hosts (${error instanceof Error ? error.message : error}); boxes will not show in the Paseo app`,
		);
	}
	for (const f of await readdir(o.dir).catch(() => [] as string[]))
		if (f.endsWith(".sock")) await rm(join(o.dir, f), { force: true });
	return gone;
}

/** One live link: the relay socket and the host registration of one box. */
export class PaseoLink {
	#server: net.Server | null = null;
	#streams = new Set<Duplex>();
	#registration: string | null = null;
	#stopped = false;
	#started: Promise<void> | null = null;
	readonly socketPath: string;
	readonly label: string;

	constructor(
		readonly o: PaseoLinkOptions,
		readonly box: Box,
		readonly item: string,
		readonly execution: string,
	) {
		this.socketPath = join(o.dir, `${execution.slice(0, 24)}.sock`);
		this.label = `${LINK_LABEL_PREFIX}${item}`;
	}

	/** The registration id once the host is added. */
	get registration(): string | null {
		return this.#registration;
	}

	/** Start in the background; a failure is logged, never thrown. */
	start(): Promise<void> {
		this.#started ??= this.#start().catch((error) => {
			(this.o.log ?? (() => {}))(
				`paseo link ${this.item}: ${error instanceof Error ? error.message : error}`,
			);
		});
		return this.#started;
	}

	async #start(): Promise<void> {
		await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
		await chmod(this.o.dir, 0o700);
		await rm(this.socketPath, { force: true });
		const server = net.createServer((client) => this.#relay(client));
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => resolve());
		});
		await chmod(this.socketPath, 0o600);
		const ready = this.o.ready ?? ((box: Box) => this.#answers(box));
		const until = Date.now() + (this.o.readyTimeoutMs ?? 120_000);
		while (!(await ready(this.box).catch(() => false))) {
			if (this.#stopped) return;
			if (Date.now() > until)
				throw new Error("the box daemon did not start; no Paseo host");
			await Bun.sleep(2000);
		}
		if (this.#stopped) return;
		const r = await (this.o.paseo ?? paseoCall)([
			"host",
			"add",
			`unix://${this.socketPath}`,
			"--label",
			this.label,
			"--meta",
			`${LINK_META.item}=${this.item}`,
			"--meta",
			`${LINK_META.runner}=${this.o.runnerId}`,
			"--meta",
			`${LINK_META.execution}=${this.execution}`,
			"--json",
		]);
		if (r.code !== 0)
			throw new Error(
				`paseo host add failed: ${firstLine(r.stderr || r.stdout)}`,
			);
		const row = JSON.parse(r.stdout) as HostRow;
		this.#registration = row.registrationId;
		if (this.#stopped) {
			await this.#unregister();
			return;
		}
		this.o.step?.(
			this.item,
			`watch in Paseo: host ${this.label} (connected to this runner's Paseo)`,
		);
	}

	/**
	 * Default readiness: the box daemon answers HTTP (cheap) AND a WebSocket
	 * call through this relay (`paseo ls`): the WebSocket answers 503 for 1-4 s
	 * after HTTP is up (mm-210.71).
	 */
	async #answers(box: Box): Promise<boolean> {
		if (!(await daemonAnswers(this.o.open, box))) return false;
		const r = await (this.o.paseo ?? paseoCall)([
			"ls",
			"--host",
			`unix://${this.socketPath}`,
			"--json",
		]);
		return r.code === 0;
	}

	#relay(client: net.Socket): void {
		this.#streams.add(client);
		client.on("close", () => this.#streams.delete(client));
		client.on("error", () => client.destroy());
		client.pause();
		this.o
			.open(this.box.id)
			.then((up) => {
				this.#streams.add(up);
				up.on("close", () => {
					this.#streams.delete(up);
					client.destroy();
				});
				up.on("error", () => up.destroy());
				client.on("close", () => up.destroy());
				client.pipe(up);
				up.pipe(client);
				client.resume();
			})
			.catch(() => client.destroy());
	}

	async #unregister(): Promise<void> {
		const id = this.#registration;
		if (!id) return;
		this.#registration = null;
		const r = await (this.o.paseo ?? paseoCall)(["host", "rm", id, "--json"]);
		if (r.code !== 0)
			(this.o.log ?? (() => {}))(
				`paseo link ${this.item}: host rm ${id} failed: ${firstLine(r.stderr || r.stdout)} (the next start removes it)`,
			);
	}

	/** Remove the host, close the relay. Never throws. */
	async stop(): Promise<void> {
		this.#stopped = true;
		await this.#started;
		await this.#unregister().catch(() => {});
		for (const s of this.#streams) s.destroy();
		const server = this.#server;
		this.#server = null;
		if (server) await new Promise<void>((r) => server.close(() => r()));
		await rm(this.socketPath, { force: true }).catch(() => {});
	}
}

/**
 * Default readiness: the box daemon answers `GET /api/status` with
 * `server_info` through the same bridge the host will use.
 */
export async function daemonAnswers(
	open: OpenStream,
	box: Box,
	timeoutMs = 5000,
): Promise<boolean> {
	const s = await open(box.id);
	return await new Promise<boolean>((resolve) => {
		let got = "";
		const done = (ok: boolean) => {
			clearTimeout(timer);
			s.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		s.on("data", (d: Buffer) => {
			got += d.toString();
			if (got.includes("server_info")) done(true);
		});
		s.on("end", () => done(got.includes("server_info")));
		s.on("error", () => done(false));
		s.write(
			"GET /api/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
	});
}

/**
 * A driver whose boxes are linked: create() starts a {@link PaseoLink} for
 * each box with an item label; destroy() removes the host before the box.
 */
export function linkDriver(driver: BoxDriver, o: PaseoLinkOptions): BoxDriver {
	return new Proxy(driver, {
		get(target, prop) {
			if (prop !== "create") {
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			}
			return async (spec: BoxSpec): Promise<Box> => {
				const box = await target.create(spec);
				const item = spec.labels[BOX_LABEL.item];
				const execution = spec.labels[BOX_LABEL.execution] ?? spec.name;
				if (!item) return box;
				const link = new PaseoLink(o, box, item, execution);
				void link.start();
				return linkedBox(box, link);
			};
		},
	});
}

function linkedBox(box: Box, link: PaseoLink): Box {
	return new Proxy(box, {
		get(target, prop) {
			if (prop === "destroy")
				return async () => {
					await link.stop();
					await target.destroy();
				};
			if (prop === "paseoLink") return link;
			const v = Reflect.get(target, prop, target);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

/**
 * A full-duplex Docker exec of the bridge in a box (Engine API: create the
 * exec, then start it on a raw connection upgraded to a TCP stream; stdout
 * comes in frames, stdin goes in raw). Podman's compatible API works too.
 */
export function dockerExecStream(
	ep: DockerEndpoint,
	opts: { user?: string } = {},
): OpenStream {
	return async (boxId) => {
		const api = "/v1.41";
		const res = await fetch(`${ep.base}${api}/containers/${boxId}/exec`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: ["node", "-e", bridgeScript()],
				...(opts.user ? { User: opts.user } : {}),
			}),
			...(ep.unix ? { unix: ep.unix } : {}),
		} as RequestInit);
		if (!res.ok) throw new Error(`exec create: ${res.status}`);
		const { Id } = (await res.json()) as { Id: string };
		const url = new URL(ep.base);
		const raw = ep.unix
			? net.connect(ep.unix)
			: net.connect(Number(url.port || 2375), url.hostname);
		const body = JSON.stringify({ Detach: false, Tty: false });
		raw.write(
			[
				`POST ${api}/exec/${Id}/start HTTP/1.1`,
				"Host: docker",
				"Content-Type: application/json",
				"Connection: Upgrade",
				"Upgrade: tcp",
				`Content-Length: ${Buffer.byteLength(body)}`,
				"",
				body,
			].join("\r\n"),
		);
		return await upgraded(raw);
	};
}

/**
 * Wait for the 101 (or 200) answer of a hijacked exec start; then return a
 * socket-like stream: writes go raw to stdin, reads are stdout (frames
 * removed, stderr dropped).
 */
function upgraded(raw: net.Socket): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end < 0) {
				if (head.length > 16_384) fail(new Error("exec start: no header end"));
				return;
			}
			raw.off("data", onData);
			raw.off("error", fail);
			const status = Number(head.subarray(0, end).toString().split(" ")[1]);
			if (status !== 101 && status !== 200) {
				raw.destroy();
				return reject(new Error(`exec start: ${status}`));
			}
			resolve(framed(raw, head.subarray(end + 4)));
		};
		const fail = (error: Error) => {
			raw.destroy();
			reject(error);
		};
		raw.on("data", onData);
		raw.once("error", fail);
	});
}

/** A duplex over `raw`: Docker's 8-byte stream frames removed on read. */
function framed(raw: net.Socket, rest: Buffer): Duplex {
	let buf = Buffer.alloc(0);
	const d = new Duplex({
		read() {
			raw.resume();
		},
		write(chunk, _enc, cb) {
			raw.write(chunk, cb);
		},
		final(cb) {
			// Half-close: the engine closes the bridge's stdin; it ends the TCP side.
			raw.end();
			cb();
		},
		destroy(error, cb) {
			raw.destroy();
			cb(error);
		},
	});
	const push = (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 8) {
			const size = buf.readUInt32BE(4);
			if (buf.length < 8 + size) break;
			const kind = buf[0];
			const frame = buf.subarray(8, 8 + size);
			buf = buf.subarray(8 + size);
			if (kind !== 2 && !d.push(frame)) raw.pause();
		}
	};
	if (rest.length) push(rest);
	raw.on("data", push);
	raw.on("end", () => d.push(null));
	raw.on("close", () => d.destroy());
	raw.on("error", (e) => d.destroy(e));
	return d;
}
