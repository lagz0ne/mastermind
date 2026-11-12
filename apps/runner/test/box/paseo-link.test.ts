import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOX_LABEL,
	type Box,
	type BoxDriver,
	type BoxSpec,
} from "../../src/box/driver.ts";
import {
	type BoxClient,
	bridgeScript,
	LINK_META,
	linkDriver,
	PaseoLink,
	type PaseoLinkOptions,
	sweepPaseoLinks,
} from "../../src/box/paseo-link.ts";
import type { PaseoConnect } from "../../src/paseo/client.ts";
import { FakePaseo } from "../paseo/fake.ts";

let dir: string;
let echo: net.Server;
let echoPort: number;
const conns = new Set<net.Socket>();

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "mm-pl-")), "link");
	echo = net.createServer((s) => {
		conns.add(s);
		s.on("close", () => conns.delete(s));
		s.on("error", () => {});
		s.pipe(s);
	});
	await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
	echoPort = (echo.address() as net.AddressInfo).port;
});
afterEach(async () => {
	for (const c of conns) c.destroy();
	await new Promise<void>((r) => echo.close(() => r()));
	await rm(join(dir, ".."), { recursive: true, force: true });
});

/** A fake Paseo SDK: its host calls as ["ls"], ["add", input], ["rm", id]. */
function fakePaseo(
	hosts: {
		registrationId: string;
		label?: string;
		metadata?: Record<string, string>;
	}[] = [],
) {
	const f = new FakePaseo();
	f.hosts = hosts.map((h) => ({
		label: null,
		metadata: {},
		connection: "",
		...h,
	}));
	const names: Record<string, string> = {
		listHosts: "ls",
		addHost: "add",
		removeHost: "rm",
	};
	return {
		call: f.connect,
		get calls(): unknown[][] {
			return f.calls
				.filter((c) => names[c.op])
				.map((c) =>
					c.arg === undefined ? [names[c.op]] : [names[c.op], c.arg],
				);
		},
	};
}

const refusing =
	(message: string): PaseoConnect =>
	async () => {
		throw new Error(message);
	};

function fakeBox(id = "box-1"): Box & { destroyed: boolean } {
	return {
		id,
		name: id,
		destroyed: false,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		copyIn: async () => {},
		copyOut: async () => new Uint8Array(),
		logs: async () => "",
		async destroy() {
			this.destroyed = true;
		},
	};
}

function opts(
	paseo: PaseoConnect,
	extra: Partial<PaseoLinkOptions> = {},
): PaseoLinkOptions & { steps: string[]; logs: string[] } {
	const steps: string[] = [];
	const logs: string[] = [];
	return {
		dir,
		runnerId: "r1",
		// The "box": a local echo server stands in for the bridge.
		open: async () => net.connect(echoPort, "127.0.0.1"),
		paseo,
		ready: async () => true,
		step: (item, line) => steps.push(`${item}: ${line}`),
		log: (l) => logs.push(l),
		steps,
		logs,
		...extra,
	};
}

function roundTrip(path: string, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = net.connect(path);
		let got = "";
		c.on("data", (d) => {
			got += d.toString();
			if (got.length >= text.length) {
				c.end();
				resolve(got);
			}
		});
		c.on("error", reject);
		c.write(text);
	});
}

describe("bridgeScript", () => {
	test("connects stdio to the box daemon port", () => {
		const js = bridgeScript();
		expect(js).toContain('connect(6767,"127.0.0.1")');
		expect(js).toContain("process.stdin.pipe(s)");
	});
});

describe("PaseoLink", () => {
	test("adds a host, relays bytes, then removes the host and the socket", async () => {
		const p = fakePaseo();
		const o = opts(p.call);
		const link = new PaseoLink(o, fakeBox(), "mm-7", "exec-abc");
		await link.start();

		expect(p.calls[0]).toEqual([
			"add",
			{
				connection: `unix://${join(dir, "exec-abc.sock")}`,
				label: "mastermind:mm-7",
				metadata: {
					[LINK_META.item]: "mm-7",
					[LINK_META.runner]: "r1",
					[LINK_META.execution]: "exec-abc",
				},
			},
		]);
		expect(link.registration).toBe("reg-1");
		expect(o.steps).toEqual([
			"mm-7: watch in Paseo: host mastermind:mm-7 (connected to this runner's Paseo)",
		]);
		// Only the runner's user can reach the socket.
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect((await stat(link.socketPath)).mode & 0o777).toBe(0o600);

		expect(await roundTrip(link.socketPath, "hello box")).toBe("hello box");

		await link.stop();
		expect(p.calls[1]).toEqual(["rm", "reg-1"]);
		expect(await readdir(dir)).toEqual([]);
	});

	test("no password and no secret in any Paseo call", async () => {
		const p = fakePaseo();
		const link = new PaseoLink(opts(p.call), fakeBox(), "mm-7", "e1");
		await link.start();
		await link.stop();
		expect(JSON.stringify(p.calls)).not.toMatch(/password|token/i);
	});

	test("waits for the box daemon before it adds the host", async () => {
		const p = fakePaseo();
		let n = 0;
		const link = new PaseoLink(
			opts(p.call, { ready: async () => ++n >= 2 }),
			fakeBox(),
			"mm-7",
			"e1",
		);
		await link.start();
		expect(n).toBe(2);
		expect(p.calls[0]?.[0]).toBe("add");
		await link.stop();
	});

	test("default readiness: HTTP server_info, then an SDK call through the relay", async () => {
		// A fake box daemon: answers every request with server_info.
		const daemon = net.createServer((c) => {
			c.on("error", () => {});
			c.once("data", () =>
				c.end(
					'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{"status":"server_info"}',
				),
			);
		});
		await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", () => r()));
		const port = (daemon.address() as net.AddressInfo).port;
		const calls: string[] = [];
		let n = 0;
		const client = {
			fetchAgents: async () => ({}),
			close: async () => {
				calls.push("close");
			},
		};
		const o = opts(fakePaseo().call, {
			open: async () => net.connect(port, "127.0.0.1"),
			// The WebSocket answers one round later than HTTP.
			connect: async (url) => {
				calls.push(`connect ${url}`);
				if (++n < 2) throw new Error("503");
				return client as unknown as BoxClient;
			},
		});
		delete o.ready;
		const link = new PaseoLink(o, fakeBox(), "mm-7", "e1");
		await link.start();
		expect(calls).toEqual([
			`connect unix://${link.socketPath}`,
			`connect unix://${link.socketPath}`,
		]);
		expect(link.registration).toBe("reg-1");
		// The connection of the check stays: it is the control connection.
		expect(await link.client()).toBe(client as unknown as BoxClient);
		await link.stop();
		expect(calls.at(-1)).toBe("close");
		await new Promise<void>((r) => daemon.close(() => r()));
	}, 15_000);

	test("register false: no host, the control connection only", async () => {
		const p = fakePaseo();
		const client = { fetchAgents: async () => ({}), close: async () => {} };
		const link = new PaseoLink(
			opts(p.call, {
				register: false,
				connect: async () => client as unknown as BoxClient,
			}),
			fakeBox(),
			"mm-7",
			"e1",
		);
		expect(await link.client()).toBe(client as unknown as BoxClient);
		expect(link.registration).toBeNull();
		expect(p.calls).toEqual([]);
		await link.stop();
	});

	test("stopped before the daemon is up: no host at all", async () => {
		const p = fakePaseo();
		const link = new PaseoLink(
			opts(p.call, { ready: async () => false }),
			fakeBox(),
			"mm-7",
			"e1",
		);
		void link.start();
		await link.stop();
		expect(p.calls).toEqual([]);
	});

	test("paseo missing or host add failing: logged, the task goes on", async () => {
		const o = opts(refusing("paseo: not found"));
		const link = new PaseoLink(o, fakeBox(), "mm-7", "e1");
		await link.start();
		expect(link.registration).toBeNull();
		expect(o.logs.join("\n")).toContain(
			"paseo host add failed: paseo: not found",
		);
		await link.stop();
		expect(await readdir(dir)).toEqual([]);
	});

	test("a bridge that cannot open closes the client, the relay stays", async () => {
		const p = fakePaseo();
		let fail = true;
		const link = new PaseoLink(
			opts(p.call, {
				open: async () => {
					if (fail) throw new Error("exec failed");
					return net.connect(echoPort, "127.0.0.1");
				},
			}),
			fakeBox(),
			"mm-7",
			"e1",
		);
		await link.start();
		await new Promise<void>((r) => {
			const c = net.connect(link.socketPath);
			c.on("close", () => r());
			c.on("error", () => {});
		});
		fail = false;
		expect(await roundTrip(link.socketPath, "again")).toBe("again");
		await link.stop();
	});
});

describe("linkDriver", () => {
	function driver() {
		const boxes: (Box & { destroyed: boolean })[] = [];
		const d: BoxDriver = {
			name: "fake",
			ping: async () => "ok",
			ensureImage: async (r) => r.image,
			create: async (spec: BoxSpec) => {
				const b = fakeBox(spec.name);
				boxes.push(b);
				return b;
			},
			list: async () => [],
			remove: async () => {},
		};
		return { d, boxes };
	}
	const spec = (labels: Record<string, string>): BoxSpec => ({
		image: "img",
		name: "mm-box-1",
		labels,
	});

	test("a box of an item is linked; destroy removes the host first", async () => {
		const p = fakePaseo();
		const { d, boxes } = driver();
		const linked = linkDriver(d, opts(p.call));
		expect(linked.name).toBe("fake");
		expect(await linked.ping()).toBe("ok");
		const box = await linked.create(
			spec({
				[BOX_LABEL.runner]: "r1",
				[BOX_LABEL.item]: "mm-9",
				[BOX_LABEL.execution]: "ex-9",
			}),
		);
		expect(box.id).toBe("mm-box-1");
		await (box as unknown as { paseoLink: PaseoLink }).paseoLink.start();
		expect(p.calls[0]?.[1]).toMatchObject({ label: "mastermind:mm-9" });
		await box.destroy();
		expect(p.calls.at(-1)).toEqual(["rm", "reg-1"]);
		expect(boxes[0]?.destroyed).toBe(true);
	});

	test("a box without an item label (doctor probe) is not linked", async () => {
		const p = fakePaseo();
		const { d } = driver();
		const box = await linkDriver(d, opts(p.call)).create(spec({}));
		await box.destroy();
		expect(p.calls).toEqual([]);
	});
});

describe("sweepPaseoLinks", () => {
	test("removes only this runner's hosts and its stale sockets", async () => {
		const p = fakePaseo([
			{ registrationId: "a", metadata: { [LINK_META.runner]: "r1" } },
			{ registrationId: "b", metadata: { [LINK_META.runner]: "r2" } },
			{ registrationId: "c", label: "my laptop", metadata: {} },
			{ registrationId: "d", metadata: { [LINK_META.runner]: "r1" } },
		]);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "old.sock"), "");
		const gone = await sweepPaseoLinks({ dir, runnerId: "r1", paseo: p.call });
		expect(gone).toEqual(["a", "d"]);
		expect(p.calls.filter((c) => c[0] === "rm").map((c) => c[1])).toEqual([
			"a",
			"d",
		]);
		expect(await readdir(dir)).toEqual([]);
	});

	test("no paseo: says so, never throws", async () => {
		const logs: string[] = [];
		const gone = await sweepPaseoLinks({
			dir,
			runnerId: "r1",
			paseo: refusing("daemon not running"),
			log: (l) => logs.push(l),
		});
		expect(gone).toEqual([]);
		expect(logs[0]).toContain("daemon not running");
	});
});

describe("startBoxMode with the Paseo link", () => {
	const fakeDriver = (): BoxDriver => ({
		name: "fake",
		ping: async () => "ok",
		ensureImage: async (r) => r.image,
		create: async (spec: BoxSpec) => fakeBox(spec.name),
		list: async () => [],
		remove: async () => {},
	});
	const base = (log: string[]) => ({
		runnerId: "r1",
		env: {},
		outDir: dir,
		log: (l: string) => log.push(l),
		driver: fakeDriver(),
	});
	const open = async () => net.connect(echoPort, "127.0.0.1");

	test("on: sweeps this runner's old hosts and links every box", async () => {
		const { startBoxMode } = await import("../../src/box/launcher.ts");
		const p = fakePaseo([
			{ registrationId: "old", metadata: { [LINK_META.runner]: "r1" } },
		]);
		const log: string[] = [];
		const m = await startBoxMode({
			...base(log),
			paseoLink: { dir, paseo: p.call, open, ready: async () => true },
		});
		expect(p.calls[1]).toEqual(["rm", "old"]);
		expect(log.join("\n")).toContain("removed 1 host(s) left");
		const box = await m.driver.create({
			image: "i",
			name: "b",
			labels: { [BOX_LABEL.item]: "mm-1", [BOX_LABEL.execution]: "e1" },
		});
		expect(
			(box as unknown as { paseoLink?: PaseoLink }).paseoLink,
		).toBeDefined();
		await box.destroy();
	});

	test("box control is on by default: no host, but the relay and runAgent", async () => {
		const { startBoxMode } = await import("../../src/box/launcher.ts");
		const p = fakePaseo();
		const m = await startBoxMode({
			...base([]),
			env: { MASTERMIND_PASEO_LINK: "0" },
			paseoLink: { dir, paseo: p.call, open, ready: async () => true },
		});
		expect(m.launcher.opts.runAgent).toBeDefined();
		const box = await m.driver.create({
			image: "i",
			name: "b",
			labels: { [BOX_LABEL.item]: "x" },
		});
		const link = (box as unknown as { paseoLink?: PaseoLink }).paseoLink;
		expect(link).toBeDefined();
		await link?.start();
		expect(link?.registration).toBeNull();
		expect(p.calls).toEqual([]);
		await box.destroy();
	});

	test("off: no link with exec control and --no-paseo-link, MASTERMIND_PASEO_LINK=0, or Paseo not answering", async () => {
		const { startBoxMode } = await import("../../src/box/launcher.ts");
		const p = fakePaseo();
		const spec = { image: "i", name: "b", labels: { [BOX_LABEL.item]: "x" } };
		const linked = async (m: { driver: BoxDriver }) =>
			(
				(await m.driver.create(spec)) as unknown as {
					paseoLink?: PaseoLink;
				}
			).paseoLink !== undefined;
		const exec = { boxControl: "exec" as const };

		const off = await startBoxMode({ ...base([]), ...exec, paseoLink: false });
		expect(await linked(off)).toBe(false);
		expect(off.launcher.opts.runAgent).toBeUndefined();
		expect(
			await linked(
				await startBoxMode({
					...base([]),
					env: { MASTERMIND_PASEO_LINK: "0", MASTERMIND_BOX_CONTROL: "exec" },
					paseoLink: { dir, paseo: p.call, open },
				}),
			),
		).toBe(false);
		// Another driver than Docker: off unless asked (the transport is Docker exec).
		expect(await linked(await startBoxMode(base([])))).toBe(false);
		expect(p.calls).toEqual([]);

		const log: string[] = [];
		const down = await startBoxMode({
			...base(log),
			...exec,
			paseoLink: {
				dir,
				open,
				paseo: refusing("no daemon"),
			},
		});
		expect(await linked(down)).toBe(false);
		expect(log.join("\n")).toContain("no daemon");
	});
});
