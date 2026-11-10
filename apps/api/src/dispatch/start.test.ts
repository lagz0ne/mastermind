import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SqlTag } from "@mastermind/beads";
import { connect } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { type NatsServer, startNats } from "./nats-server.ts";
import { type RunningDispatch, runDispatch } from "./start.ts";

const dolt = (() => Promise.resolve([])) as unknown as SqlTag;
const base = { bdUrl: "http://127.0.0.1:1", dolt, log: () => {}, backoffMs: 5 };

async function until(probe: RunningDispatch, want: "up" | "down") {
	for (let i = 0; i < 100; i++) {
		if ((await probe.probe()) === want) return;
		await Bun.sleep(20);
	}
	throw new Error(`dispatch never became ${want}`);
}

test("a shared connection that never comes: down, and stop does not hang", async () => {
	const d = runDispatch({
		...base,
		nats: { connection: new Promise(() => {}) },
	});
	expect(await d.probe()).toBe("down");
	await d.stop();
});

test("a shared connection that fails stays down and keeps retrying quietly", async () => {
	const lines: string[] = [];
	const d = runDispatch({
		...base,
		log: (l) => lines.push(l),
		nats: { connection: Promise.reject(new Error("auth stopped")) },
	});
	await Bun.sleep(50);
	expect(await d.probe()).toBe("down");
	expect(lines.some((l) => l.includes("auth stopped"))).toBe(true);
	await d.stop();
});

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

describe.skipIf(!bin)("runDispatch over nats-server", () => {
	let server: NatsServer;
	beforeAll(async () => {
		server = await startNats(bin as string);
	}, 20_000);
	afterAll(() => server?.stop());

	test("on a shared connection: up once it resolves; stop leaves it open", async () => {
		let resolve: (nc: NatsConnection) => void = () => {};
		const connection = new Promise<NatsConnection>((r) => {
			resolve = r;
		});
		const d = runDispatch({ ...base, nats: { connection } });
		expect(await d.probe()).toBe("down");
		const nc = await connect({ servers: server.url, name: "shared" });
		resolve(nc);
		await until(d, "up");
		await d.stop();
		expect(await d.probe()).toBe("down");
		expect(nc.isClosed()).toBe(false);
		await nc.drain();
	});

	test("on its own url: up, and stop closes its connection", async () => {
		const d = runDispatch({ ...base, nats: { url: server.url } });
		await until(d, "up");
		await d.stop();
		expect(await d.probe()).toBe("down");
	});
});
