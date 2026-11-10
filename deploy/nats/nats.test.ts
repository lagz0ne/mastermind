// Runs deploy/nats/nats.conf in a real nats-server and checks the safe state.
// Needs the binary: NATS_SERVER=/path/to/nats-server bun test deploy/nats
// Skips when no nats-server is found (CI does not run it; deploy/ is not a workspace).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe } from "./smoke.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
// Any valid account public nkey works: no callout service runs in this test.
const ISSUER = "ACZFR7MUZEEOF4EXQIORCTXIYTIDFDQDRC36XYDPNUGCPAO6U3WWZKGB";

describe.skipIf(!bin)("nats.conf", () => {
	let dir = "";
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	let server: ReturnType<typeof Bun.spawn> | undefined;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "mm-nats-"));
		// Same config, but local ports and a temp store dir.
		const conf = (await Bun.file(join(import.meta.dir, "nats.conf")).text())
			.replace("port: 4222", `port: ${base}`)
			.replace("http: 8222", `http: ${base + 1}`)
			.replace("port: 8080", `port: ${base + 2}`)
			.replace('"/data/jetstream"', JSON.stringify(join(dir, "js")));
		await Bun.write(join(dir, "nats.conf"), conf);
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		server = Bun.spawn([bin!, "-c", join(dir, "nats.conf")], {
			env: { NATS_AUTH_PASSWORD: PASSWORD, NATS_ISSUER_PUBLIC: ISSUER },
			stdout: "ignore",
			stderr: "pipe",
		});
		for (let i = 0; i < 50; i++) {
			const r = await fetch(`http://127.0.0.1:${base + 1}/healthz`).catch(
				() => undefined,
			);
			if (r?.ok) return;
			await Bun.sleep(100);
		}
		throw new Error(
			`nats-server did not start: ${await new Response(server.stderr as ReadableStream).text()}`,
		);
	});

	afterAll(() => {
		server?.kill();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("websocket sends INFO with auth required", async () => {
		const { info } = await probe(ws, { user: "mastermind", pass: PASSWORD });
		expect(info.server_name).toBe("mastermind-nats");
		expect(info.auth_required).toBe(true);
	});

	test("websocket answers on the /nats path too (Traefik path route, no strip)", async () => {
		const { info } = await probe(`${ws}/nats`);
		expect(info.server_name).toBe("mastermind-nats");
	});

	test("connect without auth is refused", async () => {
		const { reply } = await probe(ws);
		expect(reply).toContain("Authorization Violation");
	});

	test("connect with a bad token is refused (no callout service runs)", async () => {
		const { reply } = await probe(ws, { auth_token: "nope" });
		expect(reply).toContain("Authorization Violation");
	});

	test("the mastermind auth user connects", async () => {
		const { reply } = await probe(ws, { user: "mastermind", pass: PASSWORD });
		expect(reply).toBe("PONG");
	});

	test("wrong password for the auth user is refused", async () => {
		const { reply } = await probe(ws, { user: "mastermind", pass: "wrong" });
		expect(reply).toContain("Authorization Violation");
	});

	test("JetStream is on", async () => {
		const r = await fetch(`http://127.0.0.1:${base + 1}/jsz`);
		const jsz = (await r.json()) as { config?: { store_dir?: string } };
		expect(jsz.config?.store_dir).toStartWith(join(dir, "js"));
	});

	test("JetStream: fsync on every write; limits server 20G, account APP 10G (health warns at 80%)", async () => {
		const r = await fetch(
			`http://127.0.0.1:${base + 1}/jsz?accounts=true&config=true`,
		);
		const jsz = (await r.json()) as {
			config?: { max_storage?: number; sync_always?: boolean };
			account_details?: { name: string; reserved_storage: number }[];
		};
		expect(jsz.config?.max_storage).toBe(20e9);
		expect(jsz.config?.sync_always).toBe(true);
		const app = jsz.account_details?.find((a) => a.name === "APP");
		expect(app?.reserved_storage).toBe(10e9);
	});
});
