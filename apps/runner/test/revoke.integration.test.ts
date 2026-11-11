// mm-tgl: a NATS restart must not mark the runner revoked; a real revoke must.
// Runs the real api (apps/api/src/index.ts) and the runner CLI against a real
// nats-server with deploy/nats/nats.conf (auth callout). Opt in:
//   NATS_SERVER=/path/to/nats-server bun test test/revoke.integration.test.ts
// Skips when no nats-server is found (CI has none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import { EXIT, main } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
const OPERATOR_KEY = "test-operator-key";
const CONF = join(import.meta.dir, "../../../deploy/nats/nats.conf");
const API = join(import.meta.dir, "../../api/src/index.ts");
const CLI = join(import.meta.dir, "../src/cli.ts");

describe.skipIf(!bin)("runner: NATS restart vs revoke", () => {
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	const api = `http://127.0.0.1:${base + 3}`;
	const issuer = createAccount();
	const dir = mkdtempSync(join(tmpdir(), "mm-runner-revoke-"));
	const config = join(dir, "runner.json");
	// RUNNER_LOG=/tmp/runner.log keeps the runner output (API_LOG the api's).
	const runnerLog = process.env.RUNNER_LOG ?? join(dir, "runner.log");
	let nats: ReturnType<typeof Bun.spawn> | undefined;
	let app: ReturnType<typeof Bun.spawn> | undefined;
	let runner: ReturnType<typeof Bun.spawn> | undefined;
	let session = "";
	let csrf = "";

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
		await until(
			async () => (await fetch(`http://127.0.0.1:${base + 1}/healthz`)).ok,
			10_000,
		);
	};
	const stopNats = async () => {
		nats?.kill("SIGTERM");
		await nats?.exited;
	};
	const healthOk = async () => {
		const r = await fetch(`${api}/api/health`);
		return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
	};
	const log = () => Bun.file(runnerLog).text();
	const count = async (needle: string) =>
		(await log()).split(needle).length - 1;
	const authed = (method: string, body?: unknown) => ({
		method,
		headers: {
			cookie: session,
			"x-csrf-token": csrf,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	beforeAll(async () => {
		const conf = (await Bun.file(CONF).text())
			.replace("port: 4222", `host: 127.0.0.1\nport: ${base}`)
			.replace("http: 8222", `http: "127.0.0.1:${base + 1}"`)
			.replace("port: 8080", `host: 127.0.0.1, port: ${base + 2}`)
			.replace('"/data/jetstream"', JSON.stringify(join(dir, "js")));
		await Bun.write(join(dir, "nats.conf"), conf);
		await startNats();
		app = Bun.spawn(["bun", API], {
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
			stdout: "ignore",
			stderr: process.env.API_LOG ? Bun.file(process.env.API_LOG) : "ignore",
		});
		await until(healthOk, 90_000);

		// Log in as alice through the operator; mint an enrol token.
		const start = await fetch(`${api}/api/auth/login/start`, {
			method: "POST",
		});
		const { code } = (await start.json()) as { code: string };
		await fetch(`${api}/api/auth/login/approve`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${OPERATOR_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ code, account: "alice" }),
		});
		const poll = await fetch(`${api}/api/auth/login/poll`, {
			headers: { cookie: cookieOf(start) },
		});
		session = cookieOf(poll);
		const me = await fetch(`${api}/api/auth/me`, {
			headers: { cookie: session },
		});
		csrf = ((await me.json()) as { csrf: string }).csrf;
		const tok = await fetch(
			`${api}/api/auth/tokens`,
			authed("POST", { kind: "enrol", name: "laptop" }),
		);
		const { token } = (await tok.json()) as { token: string };

		const env = { MASTERMIND_RUNNER_CONFIG: config };
		const out: string[] = [];
		const code0 = await main(
			["enroll", token, "--url", api, "--nats-url", ws],
			{
				env,
				out: (l) => out.push(l),
				err: (l) => out.push(l),
				cwd: dir,
			},
		);
		expect(code0, out.join("\n")).toBe(EXIT.ok);

		runner = Bun.spawn(
			["bun", CLI, "start", "--queue", "backend", "--workdir", dir],
			{
				env: { ...process.env, ...env, MASTERMIND_URL: api },
				stdout: "ignore",
				stderr: Bun.file(runnerLog),
			},
		);
		await until(async () => (await log()).includes(" up: "), 20_000);
	}, 150_000);

	afterAll(async () => {
		runner?.kill();
		app?.kill();
		nats?.kill();
		await Promise.allSettled([runner?.exited, app?.exited, nats?.exited]);
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);

	test("NATS restarts and the auth callout is down for 10 s: the runner reconnects and is not revoked", async () => {
		const reconnects = await count("nats: reconnect\n");
		await stopNats();
		await startNats("not-the-password");
		await until(async () => (await count("credential refused")) > 0, 30_000);
		await Bun.sleep(10_000);
		await stopNats();
		await startNats();
		await until(
			async () => (await count("nats: reconnect\n")) > reconnects,
			45_000,
		);
		await until(healthOk, 30_000);
		expect(runner?.exitCode).toBeNull();
		expect((await loadConfig(config))?.state).toBe("active");
	}, 150_000);

	test("a real revoke ends in revoked (exit 3, config marked)", async () => {
		const list = await fetch(`${api}/api/auth/service-accounts`, {
			headers: { cookie: session },
		});
		const { serviceAccounts } = (await list.json()) as {
			serviceAccounts: { id: string }[];
		};
		const id = serviceAccounts[0]?.id ?? "";
		const del = await fetch(
			`${api}/api/auth/service-accounts/${id}`,
			authed("DELETE"),
		);
		expect(del.status).toBe(200);
		expect(await runner?.exited).toBe(EXIT.revoked);
		expect((await loadConfig(config))?.state).toBe("revoked");
		expect(await log()).toContain("Mastermind says revoked");
	}, 60_000);
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
