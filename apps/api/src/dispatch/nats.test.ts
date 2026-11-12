// The dispatcher over a real nats-server (WebSocket + JetStream). Opt in with
// NATS_SERVER=/path/to/nats-server (or nats-server on PATH); skipped otherwise.
// Work is the in-memory fake here; store/flow.test.ts runs it on the NATS store.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusError, connect, request, Store, subjects } from "@mastermind/bus";
import type {
	Ack,
	DirectOffer,
	HeartbeatReply,
	NextReply,
	NextRequest,
	OfferAnswer,
	OfferResult,
} from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { fakeWork, LEASE_MS } from "./fake-work.ts";
import {
	CONFIG_BUCKET,
	type DispatchService,
	ROUTING_KEY,
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
	let config: Store<unknown>;
	const q = (name: string, members: string[], maxPerAccount?: number) => ({
		name,
		description: "",
		members,
		...(maxPerAccount ? { maxPerAccount } : {}),
	});
	const ROUTING = {
		queues: [
			q("build", ["alice"]),
			q("race", ["alice"]),
			q("fix", ["bob"]),
			q("lease", ["alice", "bob"]),
			q("one", ["alice"], 1),
		],
		rules: [{ match: { type: "bug" }, queue: "fix" }],
	};

	beforeAll(async () => {
		server = await startNats(bin as string);
		const open = (name: string) => connect({ servers: server.url, name });
		[mm, mm2, runner] = await Promise.all([
			open("mm-1"),
			open("mm-2"),
			open("runner"),
		]);
		// Routing first, so the service starts with it.
		config = await Store.open(mm, CONFIG_BUCKET);
		await config.put(ROUTING_KEY, ROUTING);
		// Two replicas in one queue group, sharing the same work store.
		for (const nc of [mm, mm2]) {
			services.push(
				await startDispatch(nc, {
					work,
					now,
					waitMs: 2_000,
					sweepMs: 0,
					readinessGate: false,
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

	test("an account that is not a member gets not_a_member", async () => {
		work.add({ id: "mm-50" }, "build");
		const refused = await request(
			runner,
			subjects.next("carol", "build"),
			next("carol", "x"),
		).then(failed, (e: BusError) => e);
		expect(refused.code).toBe("not_a_member");
		const ghost = await request(
			runner,
			subjects.next("alice", "ghost"),
			next("alice", "x"),
		).then(failed, (e: BusError) => e);
		expect(ghost.code).toBe("not_a_member");
	});

	test("maxPerAccount: a second bead of the queue is refused while one is held", async () => {
		work.add({ id: "mm-60.1" }, "one");
		work.add({ id: "mm-60.2" }, "one");
		const first = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "one"),
			next("alice", "a1"),
		);
		expect(first.dispatch?.bead.id).toBe("mm-60.1");
		const second = await request(
			runner,
			subjects.next("alice", "one"),
			next("alice", "a2"),
		).then(failed, (e: BusError) => e);
		expect(second.code).toBe("conflict");
	});

	test("a routing change reroutes open beads that have no queue", async () => {
		work.add({ id: "mm-70", labels: ["area:api"] });
		work.add({ id: "mm-71", labels: ["area:api", "queue:build"] });
		await config.put(ROUTING_KEY, {
			...ROUTING,
			queues: [...ROUTING.queues, q("backend", ["alice"])],
			rules: [
				{ match: { labels: ["area:api"] }, queue: "backend" },
				...ROUTING.rules,
			],
		});
		for (let i = 0; i < 50; i++) {
			if (work.beads.get("mm-70")?.labels.includes("queue:backend")) break;
			await Bun.sleep(20);
		}
		expect(work.beads.get("mm-70")?.labels).toEqual([
			"area:api",
			"queue:backend",
		]);
		// A bead that has a queue keeps it.
		expect(work.beads.get("mm-71")?.labels).toEqual([
			"area:api",
			"queue:build",
		]);
		// And the new member list holds at once.
		const ok = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "backend"),
			next("alice", "b1"),
		);
		expect(ok.dispatch?.bead.id).toBe("mm-70");
	});

	test("a default queue takes unrouted beads; a runner gets one within 2 s", async () => {
		work.add({ id: "mm-75", priority: 0, labels: ["area:none"] });
		await Bun.sleep(100);
		expect(work.beads.get("mm-75")?.labels).toEqual(["area:none"]);
		const before = (await config.get(ROUTING_KEY))?.value as typeof ROUTING;
		const t0 = Date.now();
		await config.put(ROUTING_KEY, { ...before, defaultQueue: "build" });
		for (let i = 0; i < 100; i++) {
			if (work.beads.get("mm-75")?.labels.includes("queue:build")) break;
			await Bun.sleep(20);
		}
		const got = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "build"),
			next("alice", "d1"),
			{ timeout: 5_000 },
		);
		expect(got.dispatch?.bead.id).toBe("mm-75");
		expect(Date.now() - t0).toBeLessThan(2_000);
		await config.put(ROUTING_KEY, before);
	});

	test("named environments: env:<name> dispatches the definition; an unknown one stays with a reason", async () => {
		await config.put("environments", {
			environments: [
				{
					name: "scratch",
					repo: "https://github.com/acme/scratch.git",
					ref: "main",
					setup: ["bun install"],
					check: ["bun test"],
				},
			],
		});
		try {
			work.add({ id: "mm-80", priority: 0, labels: ["env:nope"] }, "build");
			work.add({ id: "mm-81", priority: 1, labels: ["env:scratch"] }, "build");
			// The watch delivers the put asynchronously: until then the
			// environments are open and mm-80 would be dispatched the old way.
			await Bun.sleep(100);
			const { dispatch } = await request<NextRequest, NextReply>(
				runner,
				subjects.next("alice", "build"),
				next("alice", "env1"),
				{ timeout: 5_000 },
			);
			expect(dispatch?.bead.id).toBe("mm-81");
			expect(dispatch?.env).toMatchObject({
				name: "scratch",
				repo: "https://github.com/acme/scratch.git",
				ref: "main",
				requires: [],
				setup: ["bun install"],
				check: ["bun test"],
				secrets: [],
			});
			expect(work.beads.get("mm-80")?.status).toBe("open");
			expect(work.beads.get("mm-80")?.labels).toContain("triage:env");
			expect(work.comments).toContainEqual({
				id: "mm-80",
				actor: "mastermind",
				text: "not dispatched: environment nope is not defined (see /environments)",
			});
		} finally {
			await config.delete("environments");
			work.beads.delete("mm-80");
		}
	});

	test("direct offer: accept gets the dispatch in the same exchange; decline and offline give reasons", async () => {
		const got: OfferResult[] = [];
		const offers: DirectOffer[] = [];
		const answer = (id: string, a: (o: DirectOffer) => OfferAnswer) =>
			runner.subscribe(subjects.runnerOffer("alice", id), {
				callback: (_e, msg) => {
					const o = JSON.parse(new TextDecoder().decode(msg.data));
					offers.push(o);
					if (!msg.reply) return;
					void request<OfferAnswer, OfferResult>(runner, msg.reply, a(o), {
						timeout: 5_000,
					}).then((r) => got.push(r));
				},
			});
		const desk = answer("desk", () => ({
			accept: true,
			runner: next("alice", "desk").runner,
		}));
		const box = answer("box", () => ({ accept: false, reason: "at capacity" }));
		await runner.flush();
		try {
			work.add({ id: "mm-90", labels: ["to:alice/desk"] });
			await services[0]?.dispatcher.direct("mm-90");
			expect(offers[0]?.bead.id).toBe("mm-90");
			expect(offers[0]?.queue).toBe("to:alice/desk");
			// The runner reads the reply to its answer a moment later.
			for (let i = 0; i < 50 && got.length < 1; i++) await Bun.sleep(20);
			expect(got[0]?.dispatch?.actor).toBe("alice/desk");
			expect(work.beads.get("mm-90")?.assignee).toBe("alice/desk");

			work.add({ id: "mm-91", labels: ["to:alice/box"] });
			await services[0]?.dispatcher.direct("mm-91");
			work.add({ id: "mm-92", labels: ["to:alice/ghost"] });
			await services[0]?.dispatcher.direct("mm-92");
			const notes = (id: string) =>
				work.comments.filter((c) => c.id === id).map((c) => c.text);
			expect(notes("mm-91")[0]).toStartWith(
				"not accepted by alice/box: alice/box: declined: at capacity.",
			);
			expect(notes("mm-92")[0]).toStartWith(
				"not accepted by alice/ghost: alice/ghost: offline",
			);
			for (let i = 0; i < 50 && got.length < 2; i++) await Bun.sleep(20);
			expect(got[1]).toEqual({ dispatch: null });
		} finally {
			desk.unsubscribe();
			box.unsubscribe();
			for (const id of ["mm-90", "mm-91", "mm-92"]) work.beads.delete(id);
		}
	});

	test("probe is up while connected", async () => {
		expect(await services[0]?.probe()).toBe("up");
		expect(errors).toEqual([]);
	});
});

describe.skipIf(!bin)("readiness gate over NATS (mm-210.59)", () => {
	let server: NatsServer;
	let mm: NatsConnection;
	let runner: NatsConnection;
	let service: DispatchService;
	const work = fakeWork();

	beforeAll(async () => {
		server = await startNats(bin as string);
		mm = await connect({ servers: server.url, name: "mm" });
		runner = await connect({ servers: server.url, name: "runner" });
		service = await startDispatch(mm, {
			work,
			waitMs: 300,
			sweepMs: 0,
			kvRules: false,
			kvEnvironments: false,
			readinessGate: true,
		});
	}, 20_000);

	afterAll(async () => {
		await service?.stop();
		await Promise.all([mm, runner].map((nc) => nc?.drain()));
		server?.stop();
	});

	test("no status: notReady; a ready status on the status subject: work", async () => {
		work.add({ id: "mm-r1" }, "build");
		const before = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "build"),
			next("alice", "laptop"),
			{ timeout: 5_000 },
		);
		expect(before.dispatch).toBeNull();
		expect(before.notReady?.[0]).toContain("no status");
		runner.publish(
			subjects.runnerStatus("alice", "laptop"),
			JSON.stringify({
				runner: "laptop",
				readiness: {
					state: "ready",
					readyEnvironments: [],
					failedChecks: [],
					checkedAt: new Date().toISOString(),
				},
			}),
		);
		await runner.flush();
		const after = await request<NextRequest, NextReply>(
			runner,
			subjects.next("alice", "build"),
			next("alice", "laptop"),
			{ timeout: 5_000 },
		);
		expect(after.dispatch?.bead.id).toBe("mm-r1");
	});

	test("two processes of one runner (mm-210.79): the newer wins; the older is superseded; one waiter", async () => {
		const ready = (session: object) =>
			JSON.stringify({
				runner: "twin",
				...session,
				readiness: {
					state: "ready",
					readyEnvironments: [],
					failedChecks: [],
					checkedAt: new Date().toISOString(),
				},
			});
		const oldP = {};
		const newP = { session: "bbbb-new", startedAt: new Date().toISOString() };
		const ask = (session: object) =>
			request<NextRequest, NextReply>(
				runner,
				subjects.next("alice", "build"),
				{ runner: { ...next("alice", "twin").runner, ...session } },
				{ timeout: 5_000 },
			);
		const status = subjects.runnerStatus("alice", "twin");
		// The old runner (no session) is alone and ready: it waits for work.
		runner.publish(status, ready(oldP));
		await runner.flush();
		const older = ask(oldP);
		await Bun.sleep(50);
		expect(service.dispatcher.debug().waiters.build).toHaveLength(1);
		// The new process says it is up: the old one's wait ends.
		runner.publish(status, ready(newP));
		await runner.flush();
		expect((await older).superseded).toContain("sends no session id");
		// The old one keeps publishing and asking: refused, never a second waiter.
		runner.publish(
			status,
			JSON.stringify({
				runner: "twin",
				readiness: {
					state: "degraded",
					readyEnvironments: [],
					failedChecks: [],
					checkedAt: null,
				},
			}),
		);
		await runner.flush();
		const newer = ask(newP);
		await Bun.sleep(50);
		expect(service.dispatcher.debug().waiters.build).toEqual([
			expect.objectContaining({ actor: "alice/twin", session: "bbbb-new" }),
		]);
		// The old status did not replace the new one: the newer gets work.
		work.add({ id: "mm-twin" }, "build");
		await service.dispatcher.ready("build");
		expect((await newer).dispatch?.bead.id).toBe("mm-twin");
		// The old one asks again: refused (after the wait), never a waiter.
		const again = ask(oldP);
		await Bun.sleep(50);
		expect(service.dispatcher.debug().waiters.build).toBeUndefined();
		expect((await again).superseded).toStartWith("superseded:");
		expect(service.dispatcher.debug().sessions?.[0]?.actor).toBe("alice/twin");
	});
});
