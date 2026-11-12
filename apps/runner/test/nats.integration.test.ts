// The runner against a real nats-server, with a stand-in Mastermind that
// serves the dispatch subjects of @mastermind/bus. Opt in:
//   NATS_SERVER=/path/to/nats-server bun test test/nats.integration.test.ts
// Skips when no nats-server is found (CI has none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BusError,
	connect,
	parseSubject,
	patterns,
	publish,
	SERVICE_QUEUE,
	serve,
	subjects,
} from "@mastermind/bus";
import type { Dispatch, NextReply, NextRequest } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { connectRunner, natsClient } from "../src/client.ts";
import { defaultSettings } from "../src/config.ts";
import { PaseoLauncher } from "../src/launcher.ts";
import { Runner } from "../src/runner.ts";
import { dispatch, FAKE_PASEO, fakePaseoDir, until } from "./fakes.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

describe.skipIf(!bin)("runner over NATS", () => {
	const dir = mkdtempSync(join(tmpdir(), "mm-runner-nats-"));
	const fake = fakePaseoDir();
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	const url = `ws://127.0.0.1:${base + 2}`;
	let server: ReturnType<typeof Bun.spawn> | undefined;
	let mm: NatsConnection;
	let rc: NatsConnection;
	let runner: Runner;
	const queue: Dispatch[] = [];
	const seen: { verb: string; bead: string; body: Record<string, unknown> }[] =
		[];
	const nextBodies: NextRequest[] = [];

	beforeAll(async () => {
		await Bun.write(
			join(dir, "nats.conf"),
			`listen: 127.0.0.1:${base}\nhttp: 127.0.0.1:${base + 1}\nwebsocket { listen: "127.0.0.1:${base + 2}", no_tls: true }\n`,
		);
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		server = Bun.spawn([bin!, "-c", join(dir, "nats.conf")], {
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
		mm = await connect({ servers: url, name: "fake-mastermind" });
		// Stand-in dispatcher: long poll of 300 ms, then null.
		serve<NextRequest, NextReply>(
			mm,
			patterns.next,
			SERVICE_QUEUE,
			async (req, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind !== "next" || req.runner.account !== s.account)
					throw new BusError("forbidden", "wrong account");
				nextBodies.push(req);
				const d = queue.shift();
				if (d) return { dispatch: d };
				await Bun.sleep(300);
				return { dispatch: null };
			},
		);
		serve<Record<string, unknown>, unknown>(
			mm,
			patterns.allBeadVerbs,
			SERVICE_QUEUE,
			(body, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind !== "bead") throw new BusError("bad_request", "subject");
				seen.push({ verb: s.verb, bead: s.bead, body });
				if (s.verb === "heartbeat") return { lease: dispatch(s.bead).lease };
				return { ok: true };
			},
		);
		await mm.flush();

		rc = await connectRunner({
			natsUrl: url,
			credential: "unused-without-auth",
			inboxPrefix: "_INBOX.alice",
			name: "runner-test",
		});
		const settings = {
			...defaultSettings("laptop"),
			queues: ["backend"],
			workdir: dir,
			agent: { provider: "claude" },
		};
		runner = new Runner({
			client: natsClient(rc, {
				id: "laptop",
				account: "alice",
				serviceAccount: "0a1b2c",
				capabilities: [],
			}),
			launcher: new PaseoLauncher({
				command: FAKE_PASEO,
				env: { FAKE_PASEO_DIR: fake.dir },
			}),
			settings,
			idleMs: 60_000,
			heartbeatMs: 100,
		});
		runner.start();
	});

	afterAll(async () => {
		await runner?.stop();
		await rc?.close();
		await mm?.close();
		server?.kill();
		rmSync(dir, { recursive: true, force: true });
		rmSync(fake.dir, { recursive: true, force: true });
	});

	test("takes a dispatch, runs the agent, heartbeats, completes", async () => {
		const d = dispatch("mm-210.99", {
			queue: "backend",
			prompt: "write the thing",
		});
		queue.push(d);
		// The runner idles 60 s after an empty next; the ready notice wakes it.
		publish(mm, subjects.ready("backend"), {
			queue: "backend",
			beadId: d.bead.id,
			at: new Date().toISOString(),
		});
		await until(() => seen.some((s) => s.verb === "complete"), 10_000);
		const complete = seen.find((s) => s.verb === "complete");
		expect(complete).toEqual({
			verb: "complete",
			bead: "mm-210.99",
			body: { actor: "alice/laptop", summary: "did: write the thing" },
		});
		expect(seen.find((s) => s.verb === "report")?.body.actor).toBe(
			"alice/laptop",
		);
		expect(nextBodies[0]?.runner).toMatchObject({
			id: "laptop",
			account: "alice",
		});
		const run = fake.calls().find((c) => c.args[0] === "run");
		expect(run?.args).toContain(dir);
	}, 15_000);

	test("a failing agent releases the bead with its reason", async () => {
		queue.push(dispatch("mm-7", { queue: "backend", prompt: "FAKE:fail" }));
		publish(mm, subjects.ready("backend"), {
			queue: "backend",
			beadId: "mm-7",
			at: new Date().toISOString(),
		});
		await until(
			() => seen.some((s) => s.verb === "release" && s.bead === "mm-7"),
			10_000,
		);
		expect(
			seen.find((s) => s.verb === "release" && s.bead === "mm-7")?.body,
		).toEqual({ actor: "alice/laptop", reason: "could not do it" });
	}, 15_000);
});
