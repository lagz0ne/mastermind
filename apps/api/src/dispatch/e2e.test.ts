// End to end: NATS + a real Dolt sql-server + bd serve. Opt in with
//   NATS_SERVER=/path/to/nats-server
//   MASTERMIND_TEST_DOLT_URL=mysql://root:pw@127.0.0.1:<port>/<scratch db>
//   BD_BIN=/path/to/native/bd   (not the npm wrapper)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BdClient, DoltReader } from "@mastermind/beads";
import { connect, request, subjects } from "@mastermind/bus";
import type { Ack, NextReply, NextRequest } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { SQL } from "bun";
import {
	bdEnv,
	bootstrap,
	checkBd,
	type Supervisor,
	serveCmd,
	supervise,
	writeWorkspace,
} from "../bd-serve.ts";
import { hasBeadsSchema, parseDoltUrl, serverUrl } from "../dolt.ts";
import { bdHeartbeat } from "./heartbeat.ts";
import { type DispatchService, startDispatch } from "./nats.ts";
import { type NatsServer, startNats } from "./nats-server.ts";
import { beadsWork } from "./work.ts";

const natsBin = process.env.NATS_SERVER ?? Bun.which("nats-server");
const doltUrl = process.env.MASTERMIND_TEST_DOLT_URL;

const runner = (account: string, id: string): NextRequest => ({
	runner: {
		id,
		account,
		serviceAccount: `${account}-sa`,
		providers: ["claude"],
		capabilities: [],
	},
});

describe.skipIf(!natsBin || !doltUrl)(
	"dispatcher e2e (NATS, Dolt, bd serve)",
	() => {
		let nats: NatsServer;
		let mm: NatsConnection;
		let client: NatsConnection;
		let bd: Supervisor;
		let sql: SQL;
		let svc: DispatchService;
		let bdClient: BdClient;
		let heartbeat: ReturnType<typeof bdHeartbeat>;
		let skew = 0;
		const scratch = mkdtempSync(join(tmpdir(), "mm-dispatch-e2e-"));
		const queue = `e2e${Date.now().toString(36)}`;

		beforeAll(async () => {
			const url = doltUrl as string;
			const target = parseDoltUrl(url);
			const bin = process.env.BD_BIN ?? "bd";
			const server = new SQL(serverUrl(url));
			if (!(await hasBeadsSchema(server, target.database))) {
				await bootstrap(bin, target, "e2e");
			}
			await server.close();
			const beadsDir = await writeWorkspace(scratch, target.database);
			const port = 20_000 + Math.floor(Math.random() * 20_000);
			const env = bdEnv(target, beadsDir);
			bd = supervise({
				cmd: serveCmd(bin, port),
				port,
				cwd: scratch,
				env,
			});
			heartbeat = bdHeartbeat({ bin, cwd: scratch, env });
			const deadline = Date.now() + 20_000;
			while ((await checkBd(bd.url)) !== "up") {
				if (Date.now() > deadline) throw new Error("bd serve never got ready");
				await Bun.sleep(100);
			}
			sql = new SQL(url);
			bdClient = new BdClient({ baseUrl: bd.url });
			nats = await startNats(natsBin as string);
			mm = await connect({ servers: nats.url, name: "mm" });
			client = await connect({ servers: nats.url, name: "runner" });
			svc = await startDispatch(mm, {
				work: beadsWork(bdClient, new DoltReader(sql), heartbeat),
				waitMs: 0,
				sweepMs: 0,
				kvRules: false,
				// Lets the test age leases without waiting five minutes.
				now: () => new Date(Date.now() + skew),
			});
		}, 180_000);

		afterAll(async () => {
			await svc?.stop();
			await Promise.all([mm?.drain(), client?.drain()]);
			nats?.stop();
			await bd?.stop();
			await sql?.close();
			rmSync(scratch, { recursive: true, force: true });
		});

		const next = (account: string, id: string) =>
			request<NextRequest, NextReply>(
				client,
				subjects.next(account, queue),
				runner(account, id),
				{ timeout: 10_000 },
			);
		const create = (title: string) =>
			bdClient.create("e2e", {
				title,
				type: "task",
				labels: [`queue:${queue}`],
			});

		test("next, heartbeat, complete: the bead closes in beads", async () => {
			const bead = await create("e2e dispatch");
			const { dispatch } = await next("alice", "laptop");
			expect(dispatch?.bead.id).toBe(bead.id);
			expect(dispatch?.actor).toBe("alice/laptop");
			const actor = dispatch?.actor as string;
			const verb = (v: "heartbeat" | "complete", body: object) =>
				request<object, Ack>(client, subjects.bead("alice", bead.id, v), body, {
					timeout: 10_000,
				});
			await verb("heartbeat", { actor });
			expect(await verb("complete", { actor, summary: "done" })).toEqual({
				ok: true,
			});
			expect((await bdClient.get(bead.id)).status).toBe("closed");
		}, 30_000);

		test("heartbeat moves leases.lease_expires_at forward", async () => {
			const bead = await create("e2e heartbeat");
			const { dispatch } = await next("erin", "long");
			expect(dispatch?.bead.id).toBe(bead.id);
			const actor = dispatch?.actor as string;
			const leaseOf = async () => {
				const [row] = (await sql`
					select lease_expires_at, heartbeat_at from leases where issue_id = ${bead.id}
				`) as { lease_expires_at: Date; heartbeat_at: Date }[];
				return {
					expires: new Date(row?.lease_expires_at as Date).getTime(),
					beat: new Date(row?.heartbeat_at as Date).getTime(),
				};
			};
			const before = await leaseOf();
			// Dolt stores seconds.
			await Bun.sleep(1_100);
			const reply = await request<object, { lease: { expiresAt: string } }>(
				client,
				subjects.bead("erin", bead.id, "heartbeat"),
				{ actor },
				{ timeout: 10_000 },
			);
			const after = await leaseOf();
			expect(after.expires).toBeGreaterThan(before.expires);
			expect(after.beat).toBeGreaterThan(before.beat);
			expect(Date.parse(reply.lease.expiresAt)).toBe(after.expires);
			// Another actor cannot renew it.
			expect(
				await heartbeat(bead.id, "erin/other").catch((e) => e.status),
			).toBe(409);
			await bdClient.close(bead.id, "e2e", "heartbeat over");
		}, 30_000);

		test("two clients at the same time never get the same bead", async () => {
			const beads = await Promise.all([create("race 1"), create("race 2")]);
			const replies = await Promise.all(
				["a", "b", "c", "d"].map((id) => next("bob", id)),
			);
			const got = replies.map((r) => r.dispatch?.bead.id).filter(Boolean);
			expect(got.sort()).toEqual(beads.map((b) => b.id).sort());
			// Done with them: the lease test must not sweep them back.
			for (const b of beads) await bdClient.close(b.id, "e2e", "race over");
		}, 30_000);

		test("a client that stops loses the lease; the bead is ready again", async () => {
			const bead = await create("e2e lease");
			const first = await next("carol", "gone");
			expect(first.dispatch?.bead.id).toBe(bead.id);
			skew = 6 * 60_000;
			try {
				expect(await svc.dispatcher.sweep()).toContain(bead.id);
			} finally {
				skew = 0;
			}
			const second = await next("dave", "fresh");
			expect(second.dispatch?.bead.id).toBe(bead.id);
			expect(second.dispatch?.actor).toBe("dave/fresh");
		}, 30_000);
	},
);
