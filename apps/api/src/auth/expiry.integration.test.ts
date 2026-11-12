// User JWT expiry against a real nats-server (mm-210.58). Needs the binary:
// NATS_SERVER=/path/to/nats-server bun test src/auth
// Skips when no nats-server is found (CI has none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	request,
	SERVICE_QUEUE,
	serve,
	subjects,
} from "@mastermind/bus";
import { errors, type NatsConnection } from "@nats-io/nats-core";
import { createAccount } from "@nats-io/nkeys";
import { type AuthService, startAuth } from "./start.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
const CONF = join(import.meta.dir, "../../../../deploy/nats/nats.conf");
const TTL_SECONDS = 2;

/** Count disconnects and expiry errors of `nc`. */
function watch(nc: NatsConnection) {
	const seen = { disconnects: 0, expiries: 0, reconnects: 0 };
	void (async () => {
		for await (const s of nc.status()) {
			if (s.type === "disconnect") seen.disconnects++;
			if (s.type === "reconnect") seen.reconnects++;
			if (
				s.type === "error" &&
				s.error instanceof errors.UserAuthenticationExpiredError
			)
				seen.expiries++;
		}
	})().catch(() => {});
	return seen;
}

describe.skipIf(!bin)("user JWT expiry against nats-server", () => {
	let dir = "";
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	let server: ReturnType<typeof Bun.spawn> | undefined;
	let svc: AuthService;
	const open: NatsConnection[] = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "mm-expiry-"));
		const conf = (await Bun.file(CONF).text())
			.replace("port: 4222", `port: ${base}`)
			.replace("http: 8222", `http: ${base + 1}`)
			.replace("port: 8080", `port: ${base + 2}`)
			.replace('"/data/jetstream"', JSON.stringify(join(dir, "js")));
		await Bun.write(join(dir, "nats.conf"), conf);
		const issuer = createAccount();
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		server = Bun.spawn([bin!, "-c", join(dir, "nats.conf")], {
			env: {
				NATS_AUTH_PASSWORD: PASSWORD,
				NATS_ISSUER_PUBLIC: issuer.getPublicKey(),
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		for (let i = 0; i < 50; i++) {
			const r = await fetch(`http://127.0.0.1:${base + 1}/healthz`).catch(
				() => undefined,
			);
			if (r?.ok) break;
			await Bun.sleep(100);
		}
		svc = await startAuth({
			natsUrl: ws,
			authUser: "mastermind",
			authPassword: PASSWORD,
			issuerSeed: new TextDecoder().decode(issuer.getSeed()),
			publicUrl: "https://mm.example",
			serviceAccountTtlSeconds: TTL_SECONDS,
			log: () => {},
		});
		serve(svc.app, "mm.u.*.q.*.next", SERVICE_QUEUE, (_req, msg) => ({
			subject: msg.subject,
		}));
		await svc.app.flush();
	});

	afterAll(async () => {
		await Promise.allSettled(open.map((nc) => nc.close()));
		await svc?.stop();
		server?.kill();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("across 3 service account expiries, Mastermind's own connection never drops and no request of it fails; the runner expires and comes back", async () => {
		const { code } = await svc.auth.startLogin("test-browser");
		await svc.auth.approveLogin(code, "admin", { kind: "operator" });
		const enrolled = await svc.auth.enrol(
			await svc.auth.enrolToken("admin", "laptop"),
		);
		if (!enrolled) throw new Error("enrol failed");
		const runner = await connect({
			servers: ws,
			name: "runner",
			token: enrolled.credential,
			inboxPrefix: "_INBOX.admin",
			timeout: 2000,
			retryAuthErrors: true,
		});
		open.push(runner);
		const app = watch(svc.app);
		const run = watch(runner);

		let ok = 0;
		const failed: unknown[] = [];
		const until = performance.now() + (3 * TTL_SECONDS + 1.5) * 1000;
		while (performance.now() < until) {
			try {
				await request(
					svc.app,
					subjects.next("admin", "backend"),
					{},
					{
						timeout: 1000,
					},
				);
				ok++;
			} catch (error) {
				failed.push(error);
			}
			await Bun.sleep(50);
		}

		expect(failed).toEqual([]);
		expect(ok).toBeGreaterThan(50);
		expect(app).toEqual({ disconnects: 0, expiries: 0, reconnects: 0 });
		// The TTL is real: the runner was cut at least 3 times and came back.
		expect(run.expiries).toBeGreaterThanOrEqual(3);
		await runner.flush();
		const back = await request<object, { subject: string }>(
			runner,
			subjects.next("admin", "backend"),
			{},
			{ timeout: 2000 },
		);
		expect(back.subject).toBe("mm.u.admin.q.backend.next");
	}, 30_000);
});
