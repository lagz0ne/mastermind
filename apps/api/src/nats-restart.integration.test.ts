// Incident mm-210.38: NATS restarted and the api never got its connections
// back. This runs the real api (src/index.ts) against a real nats-server with
// deploy/nats/nats.conf (auth callout), stops NATS for NATS_DOWN_MS (default
// 60 s), starts it again on the same ports and store, and checks that the api
// serves health, login start, the board and the dispatcher again with no manual
// step. Needs the binary: NATS_SERVER=/path/to/nats-server bun test nats-restart
// (API_LOG=/tmp/api.log keeps the api output; NATS_DOWN_MS shortens the outage).
// Skips when no nats-server is found (CI has none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, request, subjects } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { createAccount } from "@nats-io/nkeys";
import { startAuth } from "./auth/start.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const DOWN_MS = Number(process.env.NATS_DOWN_MS ?? 60_000);
const BACK_WITHIN_MS = 15_000;
const PASSWORD = "test-secret";
const OPERATOR_KEY = "test-operator-key";
const CONF = join(import.meta.dir, "../../../deploy/nats/nats.conf");

describe.skipIf(!bin)("api survives a NATS restart", () => {
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	const api = `http://127.0.0.1:${base + 3}`;
	const issuer = createAccount();
	let dir = "";
	let nats: ReturnType<typeof Bun.spawn> | undefined;
	let app: ReturnType<typeof Bun.spawn> | undefined;
	let session = "";
	let csrf = "";
	let credential = "";
	const open: NatsConnection[] = [];

	/** `password`: the callout user's password; a wrong one keeps the callout out. */
	const startNats = async (password = PASSWORD) => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		nats = Bun.spawn([bin!, "-c", join(dir, "nats.conf")], {
			env: {
				NATS_AUTH_PASSWORD: password,
				NATS_ISSUER_PUBLIC: issuer.getPublicKey(),
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		await until(async () => {
			const r = await fetch(`http://127.0.0.1:${base + 1}/healthz`);
			return r.ok;
		}, 10_000);
	};

	const healthOk = async () => {
		const r = await fetch(`${api}/api/health`);
		return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
	};

	const loginStart = () =>
		fetch(`${api}/api/auth/login/start`, { method: "POST" });

	const board = () =>
		fetch(`${api}/api/board`, { headers: { cookie: session } });

	const stopNats = async () => {
		nats?.kill("SIGTERM");
		await nats?.exited;
	};

	/** Health, login start, the board and the dispatcher work again. */
	const serving = async (withinMs: number) => {
		const back = performance.now();
		await until(healthOk, withinMs);
		await until(async () => (await loginStart()).status === 201, withinMs);
		await until(async () => (await board()).status === 200, withinMs);
		await until(async () => (await next()) === "answered", withinMs);
		expect(performance.now() - back).toBeLessThan(withinMs);
	};

	/** A runner asks for work; any typed answer means the dispatcher serves. */
	const next = async () => {
		const nc = await connect({
			servers: ws,
			name: "test-runner",
			token: credential,
			inboxPrefix: "_INBOX.alice",
			timeout: 2_000,
		});
		open.push(nc);
		try {
			return await request(
				nc,
				subjects.next("alice", "backend"),
				{ runner: "laptop", capacity: 1 },
				{ timeout: 2_000 },
			).then(
				() => "answered",
				(error: unknown) =>
					String(error).includes("no responders") ||
					String(error).includes("TIMEOUT")
						? "silent"
						: "answered",
			);
		} finally {
			await nc.close();
		}
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "mm-restart-"));
		const conf = (await Bun.file(CONF).text())
			.replace("port: 4222", `host: 127.0.0.1\nport: ${base}`)
			.replace("http: 8222", `http: "127.0.0.1:${base + 1}"`)
			.replace("port: 8080", `host: 127.0.0.1, port: ${base + 2}`)
			.replace('"/data/jetstream"', JSON.stringify(join(dir, "js")));
		await Bun.write(join(dir, "nats.conf"), conf);
		await startNats();

		app = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], {
			env: {
				...process.env,
				PORT: String(base + 3),
				NODE_ENV: "production",
				NATS_WS_URL: ws,
				NATS_AUTH_PASSWORD: PASSWORD,
				NATS_ISSUER_SEED: new TextDecoder().decode(issuer.getSeed()),
				MASTERMIND_OPERATOR_KEY: OPERATOR_KEY,
				PUBLIC_URL: api,
				OTEL_EXPORTER_OTLP_ENDPOINT: "",
			},
			stdout: process.env.API_LOG ? Bun.file(process.env.API_LOG) : "ignore",
			stderr: process.env.API_LOG
				? Bun.file(`${process.env.API_LOG}.err`)
				: "ignore",
		});
		await until(healthOk, 90_000);

		// Log in as alice through the operator, and enrol a runner.
		const start = await loginStart();
		const { code } = (await start.json()) as { code: string };
		const login = cookieOf(start);
		const ok = await fetch(`${api}/api/auth/login/approve`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${OPERATOR_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ code, account: "alice" }),
		});
		expect(ok.status).toBe(200);
		const poll = await fetch(`${api}/api/auth/login/poll`, {
			headers: { cookie: login },
		});
		session = cookieOf(poll);
		csrf = (
			(await (
				await fetch(`${api}/api/auth/me`, { headers: { cookie: session } })
			).json()) as { csrf: string }
		).csrf;
		const tok = await fetch(`${api}/api/auth/tokens`, {
			method: "POST",
			headers: {
				cookie: session,
				"x-csrf-token": csrf,
				"content-type": "application/json",
			},
			body: JSON.stringify({ kind: "enrol", name: "laptop" }),
		});
		const { token } = (await tok.json()) as { token: string };
		const enrol = await fetch(`${api}/api/auth/enrol`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		credential = ((await enrol.json()) as { credential: string }).credential;
	}, 120_000);

	afterAll(async () => {
		await Promise.allSettled(open.map((nc) => nc.close()));
		app?.kill();
		nats?.kill();
		await Promise.allSettled([app?.exited, nats?.exited]);
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test(
		`NATS down for ${DOWN_MS / 1000} s, then up: health, login, board and dispatcher are back within ${BACK_WITHIN_MS / 1000} s`,
		async () => {
			await serving(5_000);
			await stopNats();
			await until(async () => !(await healthOk()), 10_000);
			await Bun.sleep(DOWN_MS);
			expect(app?.exitCode).toBeNull();
			await startNats();
			await serving(BACK_WITHIN_MS);
			expect(app?.exitCode).toBeNull();
		},
		DOWN_MS + 4 * BACK_WITHIN_MS + 30_000,
	);

	// The incident: NATS is back, but the api's APP and SYS connections log in
	// through the api's own auth callout, which is not serving yet. They get
	// "Authorization Violation" on more than one reconnect; nats.js closes a
	// connection for good after two auth errors unless told otherwise.
	test("NATS back before the auth callout serves: the api still recovers", async () => {
		await serving(5_000);
		await stopNats();
		await startNats("not-the-password");
		await until(async () => !(await healthOk()), 10_000);
		await Bun.sleep(10_000);
		await stopNats();
		await startNats();
		await serving(BACK_WITHIN_MS);
		expect(app?.exitCode).toBeNull();
	}, 90_000);

	test("a connection forced into closed reports its name (the api then exits); stop() does not", async () => {
		const closed: string[] = [];
		const svc = await startAuth({
			natsUrl: ws,
			authUser: "mastermind",
			authPassword: PASSWORD,
			issuerSeed: new TextDecoder().decode(issuer.getSeed()),
			publicUrl: api,
			log: () => {},
			onClosed: (name) => closed.push(name),
		});
		await svc.app.close();
		await until(async () => closed.length === 1, 2_000);
		expect(closed).toEqual(["mastermind"]);
		await svc.stop();
		await Bun.sleep(200);
		expect(closed).toEqual(["mastermind"]);
	});
});

function cookieOf(r: Response): string {
	return r.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.filter((c) => !c?.endsWith("="))
		.join("; ");
}

async function until(
	check: () => Promise<boolean>,
	withinMs: number,
): Promise<void> {
	const end = performance.now() + withinMs;
	for (;;) {
		if (await check().catch(() => false)) return;
		if (performance.now() > end)
			throw new Error(`not true within ${withinMs} ms`);
		await Bun.sleep(250);
	}
}
