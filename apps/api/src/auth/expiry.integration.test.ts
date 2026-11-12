// User JWT expiry against a real nats-server (mm-210.58). Needs the binary:
// NATS_SERVER=/path/to/nats-server bun test src/auth
// Skips when no nats-server is found (CI has none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	connect,
	request,
	SERVICE_QUEUE,
	serve,
	subjects,
} from "@mastermind/bus";
import {
	freePortsConf,
	startNatsServer,
	type TestNats,
} from "@mastermind/work/test";
import { errors, type NatsConnection } from "@nats-io/nats-core";
import { createAccount } from "@nats-io/nkeys";
import { type AuthService, startAuth } from "./start.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
const CONF = join(import.meta.dir, "../../../../deploy/nats/nats.conf");
// Server start and the auth service's buckets (sync_interval: always) can take
// more than bun's 5 s on a busy machine (mm-ut1).
const START_TIMEOUT_MS = 30_000;
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
	let ws = "";
	let server: TestNats | undefined;
	let svc: AuthService;
	const open: NatsConnection[] = [];

	beforeAll(async () => {
		const deploy = await Bun.file(CONF).text();
		const issuer = createAccount();
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		server = await startNatsServer(bin!, {
			prefix: "mm-expiry-",
			conf: (dir) =>
				freePortsConf(deploy, dir, {
					client: 4222,
					http: 8222,
					websocket: 8080,
				}),
			env: {
				NATS_AUTH_PASSWORD: PASSWORD,
				NATS_ISSUER_PUBLIC: issuer.getPublicKey(),
			},
		});
		ws = server.url;
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
	}, START_TIMEOUT_MS);

	afterAll(async () => {
		await Promise.allSettled(open.map((nc) => nc.close()));
		await svc?.stop();
		server?.stop();
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
		// One runner cycle is the TTL plus the reconnect wait (2-3 s), so 3
		// expiries take about 12 s. Run at least 3 TTLs, then until the runner
		// expired 3 times (or 25 s pass: the expect below then says why).
		const start = performance.now();
		const minUntil = start + 3 * TTL_SECONDS * 1000;
		const maxUntil = start + 25_000;
		while (
			performance.now() < minUntil ||
			(run.expiries < 3 && performance.now() < maxUntil)
		) {
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
		// The runner keeps expiring, so one request may meet a cut: it must
		// get through within the next reconnect.
		let back: { subject: string } | undefined;
		for (let i = 0; i < 20 && !back; i++) {
			back = await request<object, { subject: string }>(
				runner,
				subjects.next("admin", "backend"),
				{},
				{ timeout: 1000 },
			).catch(() => undefined);
			if (!back) await Bun.sleep(250);
		}
		expect(back?.subject).toBe("mm.u.admin.q.backend.next");
	}, 60_000);
});
