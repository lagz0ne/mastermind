// A service account reads and writes its own account's files bucket and no
// other (mm-210.60). Runs deploy/nats/nats.conf with the auth callout of
// startAuth; needs NATS_SERVER=/path/to/nats-server. Skips without one (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountFilesBucket,
	connect,
	Files,
	INPUTS_BUCKET,
} from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { createAccount } from "@nats-io/nkeys";
import { type AuthService, startAuth } from "../auth/start.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const PASSWORD = "test-secret";
const CONF = join(import.meta.dir, "../../../../deploy/nats/nats.conf");

describe.skipIf(!bin)("files buckets and the auth callout", () => {
	let dir = "";
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const ws = `ws://127.0.0.1:${base + 2}`;
	let server: ReturnType<typeof Bun.spawn> | undefined;
	let svc: AuthService;
	const open: NatsConnection[] = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "mm-files-auth-"));
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
			stderr: "ignore",
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
	}, 15_000);

	afterAll(async () => {
		await Promise.allSettled(open.map((nc) => nc.close()));
		await svc?.stop();
		server?.kill();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const runnerOf = async (account: string) => {
		const enrolled = await svc.auth.enrol(
			await svc.auth.enrolToken(account, "laptop"),
		);
		if (!enrolled) throw new Error("enrol failed");
		const nc = await connect({
			servers: ws,
			name: `runner-${account}`,
			token: enrolled.credential,
			inboxPrefix: `_INBOX.${account}`,
			timeout: 2000,
		});
		open.push(nc);
		return nc;
	};

	test("a service account of alice uses mm_files_alice and cannot read bob's bucket or the inputs", async () => {
		// The api (APP connection) makes the buckets and puts bob's file.
		await Files.open(svc.app, accountFilesBucket("alice"), { create: true });
		const bob = await Files.open(svc.app, accountFilesBucket("bob"), {
			create: true,
		});
		await bob.put("it-1/out/secret.txt", new Blob(["bob only"]).stream());
		const inputs = await Files.open(svc.app, INPUTS_BUCKET, { create: true });
		await inputs.put("it-1/in/a.txt", new Blob(["inputs"]).stream());

		const alice = await runnerOf("alice");
		const own = await Files.open(alice, accountFilesBucket("alice"));
		const info = await own.put(
			"it-2/out/patch.diff",
			new Blob(["diff --git"]).stream(),
		);
		expect(info.size).toBe(10);
		const got = await own.get("it-2/out/patch.diff");
		expect(got && (await new Response(got.data).text())).toBe("diff --git");
		expect((await own.list("it-2/")).map((f) => f.name)).toEqual([
			"it-2/out/patch.diff",
		]);
		expect(await own.delete("it-2/out/patch.diff")).toBe(true);

		for (const other of [accountFilesBucket("bob"), INPUTS_BUCKET]) {
			await expect(Files.open(alice, other)).rejects.toThrow();
			// A raw read of bob's chunks or meta is refused too.
			await expect(
				alice.request(
					`$JS.API.STREAM.MSG.GET.OBJ_${other}`,
					JSON.stringify({ last_by_subj: `$O.${other}.M.>` }),
					{ timeout: 1000 },
				),
			).rejects.toThrow();
		}
		// A write into bob's bucket is refused (the server drops it, no ack).
		await expect(
			alice.request(`$O.mm_files_bob.C.x`, "x", { timeout: 1000 }),
		).rejects.toThrow();
		expect((await bob.list()).map((f) => f.name)).toEqual([
			"it-1/out/secret.txt",
		]);
	}, 20_000);
});
