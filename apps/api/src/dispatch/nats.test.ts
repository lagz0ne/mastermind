// The dispatcher over a real nats-server (WebSocket + JetStream). Opt in with
// NATS_SERVER=/path/to/nats-server (or nats-server on PATH); skipped otherwise.
// Work is the in-memory fake here; dolt.e2e.test.ts runs it against bd serve.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusError, connect, request, Store, subjects } from "@mastermind/bus";
import type {
	Ack,
	HeartbeatReply,
	NextReply,
	NextRequest,
} from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { fakeWork, LEASE_MS } from "./fake-work.ts";
import {
	CONFIG_BUCKET,
	type DispatchService,
	RULES_KEY,
	startDispatch,
} from "./nats.ts";
import { type NatsServer, startNats } from "./nats-server.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

const failed = (): never => {
	throw new Error("expected the request to fail");
};

const next = (account: string, id: string, capabilities: string[] = []) =>
	({
		runner: {
			id,
			account,
			serviceAccount: `${account}-sa`,
			providers: ["claude"],
			capabilities,
		},
	}) satisfies NextRequest;

describe.skipIf(!bin)("dispatcher over NATS", () => {
	let server: NatsServer;
	let mm: NatsConnection;
	let mm2: NatsConnection;
	let runner: NatsConnection;
	let clock = new Date("2026-11-10T08:00:00Z");
	const now = () => clock;
	const work = fakeWork(now);
	const services: DispatchService[] = [];
	const errors: unknown[] = [];

	beforeAll(async () => {
		server = await startNats(bin as string);
		const open = (name: string) => connect({ servers: server.url, name });
		[mm, mm2, runner] = await Promise.all([
			open("mm-1"),
			open("mm-2"),
			open("runner"),
		]);
		// Rules first, so the service starts with them.
		const config = await Store.open(mm, CONFIG_BUCKET);
		await config.put(RULES_KEY, [{ match: { type: "bug" }, queue: "fix" }]);
		// Two replicas in one queue group, sharing the same work store.
		for (const nc of [mm, mm2]) {
			services.push(
				await startDispatch(nc, {
					work,
					now,
					waitMs: 2_000,
					sweepMs: 0,
					onError: (e) => errors.push(e),
				}),
			);
		}
	}, 20_000);

	afterAll(async () => {
		for (const s of services) await s.stop();
		await Promise.all([mm, mm2, runner].map((nc) => nc?.drain()));
		server?.stop();
	});

	test("next, heartbeat, report, complete", async () => {
		work.add({ id: "mm-10.1", title: "build it" }, "build");
		const { dispatch } = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "build"),
			next("alice", "laptop"),
			{ timeout: 5_000 },
		);
		expect(dispatch?.bead.id).toBe("mm-10.1");
		const actor = dispatch?.actor as string;
		expect(actor).toBe("alice/laptop");

		clock = new Date(clock.getTime() + 60_000);
		const hb = await request<{ actor: string }, HeartbeatReply>(
			runner,
			subjects.bead("alice", "mm-10.1", "heartbeat"),
			{ actor },
		);
		expect(Date.parse(hb.lease.expiresAt)).toBe(clock.getTime() + LEASE_MS);

		await request<unknown, Ack>(
			runner,
			subjects.bead("alice", "mm-10.1", "report"),
			{ actor, message: "halfway" },
		);
		const done = await request<unknown, Ack>(
			runner,
			subjects.bead("alice", "mm-10.1", "complete"),
			{ actor, summary: "shipped" },
		);
		expect(done).toEqual({ ok: true });
		expect(work.beads.get("mm-10.1")?.status).toBe("closed");
		expect(work.comments).toContainEqual({
			id: "mm-10.1",
			actor,
			text: "halfway",
		});
	});

	test("errors cross the bus typed", async () => {
		const err = await request(
			runner,
			subjects.bead("alice", "mm-nope", "complete"),
			{ actor: "alice/x", summary: "?" },
		).then(failed, (e: BusError) => e);
		expect(err).toBeInstanceOf(BusError);
		expect(err.code).toBe("not_found");
		const forbidden = await request(
			runner,
			subjects.next("alice", "build"),
			next("bob", "x"),
		).then(failed, (e: BusError) => e);
		expect(forbidden.code).toBe("forbidden");
	});

	test("concurrent runners never get the same bead", async () => {
		for (let i = 0; i < 4; i++) work.add({ id: `mm-20.${i}` }, "race");
		work.claimDelayMs = 5;
		const replies = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				request<NextRequest, NextReply>(
					runner,
					subjects.next("alice", "race"),
					next("alice", `r${i}`),
					{ timeout: 5_000 },
				),
			),
		);
		work.claimDelayMs = 0;
		const ids = replies.map((r) => r.dispatch?.bead.id).filter(Boolean);
		expect(ids.sort()).toEqual(["mm-20.0", "mm-20.1", "mm-20.2", "mm-20.3"]);
	});

	test("long poll: a bead routed by a journal event reaches the waiting runner", async () => {
		const pending = request<NextRequest, NextReply>(
			runner,
			subjects.next("bob", "fix"),
			next("bob", "desk"),
			{ timeout: 5_000 },
		);
		await Bun.sleep(100);
		const bead = work.add({ id: "mm-30", type: "bug" });
		// Only one replica tails the journal here; its label write is a new event.
		await services[0]?.dispatcher.onEvent({
			seq: 1,
			at: "",
			op: "create",
			beadId: bead.id,
			actor: "x",
			bead,
		});
		const routed = work.beads.get("mm-30");
		expect(routed?.labels).toEqual(["queue:fix"]);
		await services[1]?.dispatcher.onEvent({
			seq: 2,
			at: "",
			op: "update",
			beadId: "mm-30",
			actor: "mastermind",
			bead: routed,
		});
		const { dispatch } = await pending;
		expect(dispatch?.bead.id).toBe("mm-30");
		expect(dispatch?.actor).toBe("bob/desk");
	});

	test("a runner that stops loses the lease; the bead is ready again", async () => {
		work.add({ id: "mm-40" }, "lease");
		const first = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "lease"),
			next("alice", "gone"),
		);
		expect(first.dispatch?.bead.id).toBe("mm-40");
		clock = new Date(clock.getTime() + LEASE_MS + 1_000);
		// Earlier tests' beads are still held too; their leases died as well.
		expect(await services[0]?.dispatcher.sweep()).toContain("mm-40");
		const second = await request<NextRequest, NextReply>(
			runner,
			subjects.next("bob", "lease"),
			next("bob", "fresh"),
		);
		expect(second.dispatch?.bead.id).toBe("mm-40");
		const stale = await request(
			runner,
			subjects.bead("alice", "mm-40", "heartbeat"),
			{ actor: "alice/gone" },
		).then(failed, (e: BusError) => e);
		expect(stale.code).toBe("conflict");
	});

	test("probe is up while connected", async () => {
		expect(await services[0]?.probe()).toBe("up");
		expect(errors).toEqual([]);
	});
});
