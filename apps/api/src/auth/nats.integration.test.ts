// Runs deploy/nats/nats.conf in a real nats-server with the auth callout of
// startAuth. Needs the binary: NATS_SERVER=/path/to/nats-server bun test src/auth
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
import type { NatsConnection } from "@nats-io/nats-core";
import { createAccount } from "@nats-io/nkeys";
import { type AuthService, startAuth } from "./start.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
const CONF = join(import.meta.dir, "../../../../deploy/nats/nats.conf");

describe.skipIf(!bin)("auth against nats-server", () => {
	let dir = "";
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	let server: ReturnType<typeof Bun.spawn> | undefined;
	let svc: AuthService;
	const open: NatsConnection[] = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "mm-auth-"));
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
			log: () => {},
		});
		// What the dispatcher does: serve next for every account.
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

	const runner = async (token: string, account: string) => {
		const nc = await connect({
			servers: ws,
			name: "runner",
			token,
			inboxPrefix: `_INBOX.${account}`,
			timeout: 2000,
		});
		open.push(nc);
		return nc;
	};

	test("login by code on JetStream KV: N approvals and N polls, one session", async () => {
		const { code, cookie } = await svc.auth.startLogin("test-browser");
		const approvals = await Promise.allSettled(
			Array.from({ length: 10 }, () =>
				svc.auth.approveLogin(code, "admin", { kind: "operator" }),
			),
		);
		expect(approvals.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const polls = await Promise.all(
			Array.from({ length: 10 }, () => svc.auth.pollLogin(cookie)),
		);
		const won = polls.filter((p) => p.status === "approved");
		expect(won).toHaveLength(1);
		expect(won[0]).toMatchObject({ account: "admin" });
		await expect(
			svc.auth.approveLogin(code, "admin", { kind: "operator" }),
		).rejects.toThrow("no such code");
	});

	test("a runner enrols, connects, and stays inside its account", async () => {
		const enrolled = await svc.auth.enrol(
			await svc.auth.enrolToken("admin", "laptop"),
		);
		if (!enrolled) throw new Error("enrol failed");
		const nc = await runner(enrolled.credential, "admin");
		const ok = await request<object, { subject: string }>(
			nc,
			subjects.next("admin", "backend"),
			{},
		);
		expect(ok.subject).toBe("mm.u.admin.q.backend.next");
		await expect(
			request(nc, subjects.next("bob", "backend"), {}, { timeout: 1000 }),
		).rejects.toThrow();
	});

	test("unknown or forged credentials cannot connect", async () => {
		await expect(runner("mms_admin_00_nope", "admin")).rejects.toThrow(
			/Authorization Violation/i,
		);
		await expect(runner("", "admin")).rejects.toThrow();
	});

	test("revoke disconnects the runner and refuses its credential", async () => {
		const enrolled = await svc.auth.enrol(
			await svc.auth.enrolToken("admin", "ci"),
		);
		if (!enrolled) throw new Error("enrol failed");
		const nc = await connect({
			servers: ws,
			name: "runner-revoked",
			token: enrolled.credential,
			inboxPrefix: "_INBOX.admin",
		});
		open.push(nc);
		const disconnected = (async () => {
			for await (const s of nc.status())
				if (s.type === "disconnect") return true;
			return false;
		})();
		expect(await svc.auth.revoke("admin", enrolled.serviceAccount.id)).toBe(
			true,
		);
		expect(
			await Promise.race([disconnected, Bun.sleep(3000).then(() => false)]),
		).toBe(true);
		await expect(runner(enrolled.credential, "admin")).rejects.toThrow(
			/Authorization Violation/i,
		);
	});
});
