// NatsWork against a real nats-server: NATS_TEST_URL, or NATS_SERVER (or
// nats-server on PATH) for a throwaway one. Skipped when there is none (CI).
// The claim/lease/release semantics shared with the fake are in
// apps/api/src/store/contract.test.ts; this file covers what only the
// stream store has: journal, timeline, projection, ids, lease renewals.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "@mastermind/bus";
import {
	type BeadEvent,
	foldTimeline,
	type Lease,
	queueLabel,
} from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { AlreadyClaimed, NotFound } from "./errors.ts";
import { natsAvailable, type TestNats, testNats } from "./nats-server.ts";
import { NatsWork, type NatsWorkOptions } from "./store.ts";

const run = Date.now().toString(36);
let n = 0;
/** Fresh stream, subject and bucket names per store. */
function names(): NatsWorkOptions {
	const k = `${run}${n++}`;
	return {
		stream: `T_WORK_${k}`,
		subject: `t.work.${k}`,
		leaseBucket: `t_leases_${k}`,
	};
}

describe.skipIf(!natsAvailable())("NatsWork on nats-server", () => {
	let nats: TestNats;
	let nc: NatsConnection;
	const open: NatsWork[] = [];
	const store = async (opts: NatsWorkOptions = {}) => {
		const w = await NatsWork.open(nc, { ...names(), ...opts });
		open.push(w);
		return w;
	};

	beforeAll(async () => {
		nats = await testNats();
		nc = await connect({ servers: nats.url, name: "work-test" });
	});
	afterAll(async () => {
		for (const w of open) w.stop();
		await nc?.drain();
		nats?.stop();
	});

	test("ids are short, prefixed base36, and unique", async () => {
		const w = await store({ prefix: "wk" });
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const b = await w.create("ann", { title: `t${i}` });
			expect(b.id).toMatch(/^wk-[0-9a-z]{4,}$/);
			ids.add(b.id);
		}
		expect(ids.size).toBe(50);
	});

	test("journal: seq order, resume after a cursor, recent newest first", async () => {
		const w = await store();
		const a = await w.create("ann", { title: "a", labels: ["x"] });
		await w.setLabels(a.id, "mastermind", ["x", queueLabel("be")]);
		await w.comment(a.id, "ann", "hello");
		await w.waitFor(2, 2_000);
		const all = await w.journalSince(0);
		expect(all.map((e) => e.op)).toEqual(["create", "update", "comment"]);
		expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(await w.head()).toBe(3);
		expect((await w.journalSince(1)).map((e) => e.seq)).toEqual([2, 3]);
		expect(await w.journalSince(3)).toEqual([]);
		expect((await w.journalRecent(2)).map((e) => e.seq)).toEqual([3, 2]);
		expect((await w.journalRecent(10, 3)).map((e) => e.seq)).toEqual([2, 1]);
		expect((await w.comments(a.id)).map((c) => c.text)).toEqual(["hello"]);
	});

	test("timeline of one item: created, routed, claimed, report, released, completed", async () => {
		const w = await store();
		const other = await w.create("bob", { title: "other" });
		const a = await w.create("ann", { title: "a" });
		await w.setLabels(a.id, "mastermind", [queueLabel("be")]);
		await w.claim(a.id, "ann/agent");
		await w.comment(a.id, "ann/agent", "half way");
		await w.comment(a.id, "ann/agent", "released: stuck");
		await w.release(a.id, "ann/agent");
		await w.claim(a.id, "bob/agent");
		await w.close(a.id, "bob/agent", "done it");
		await w.comment(other.id, "bob", "unrelated");
		const events = await w.journalOf(a.id);
		expect(events.every((e) => e.beadId === a.id)).toBe(true);
		const kinds = foldTimeline(events).entries.map((e) => e.kind);
		expect(kinds).toEqual([
			"created",
			"routed",
			"claimed",
			"report",
			"released",
			"claimed",
			"completed",
		]);
		const released = foldTimeline(events).entries.find(
			(e) => e.kind === "released",
		);
		expect(released?.text).toBe("stuck");
	});

	test("heartbeats renew in KV: no journal event, the board shows the new lease", async () => {
		let t = new Date("2026-11-10T10:00:00Z");
		const w = await store({ now: () => t });
		const a = await w.create("ann", { title: "a" });
		const claim = await w.claim(a.id, "ann/x");
		await w.waitFor(1, 2_000);
		const head = await w.head();
		t = new Date(t.getTime() + 60_000);
		const hb = await w.heartbeat(a.id, "ann/x");
		expect(Date.parse(hb.lease?.expiresAt ?? "")).toBeGreaterThan(
			Date.parse(claim.bead.lease?.expiresAt ?? ""),
		);
		expect(await w.head()).toBe(head);
		expect((await w.get(a.id)).lease).toEqual(hb.lease);
		expect((await w.board())[0]?.lease).toEqual(hb.lease);
		expect(await w.leases()).toEqual([
			{ beadId: a.id, lease: hb.lease as Lease },
		]);
	});

	test("claim takes over an expired lease; a live one is refused", async () => {
		let t = new Date("2026-11-10T10:00:00Z");
		const w = await store({ now: () => t, leaseMs: 60_000 });
		const a = await w.create("ann", { title: "a" });
		await w.claim(a.id, "ann/x");
		expect(w.claim(a.id, "bob/y")).rejects.toBeInstanceOf(AlreadyClaimed);
		t = new Date(t.getTime() + 61_000);
		const res = await w.claim(a.id, "bob/y");
		expect(res.bead.assignee).toBe("bob/y");
		expect(w.heartbeat(a.id, "ann/x")).rejects.toThrow(/already claimed/);
	});

	test("a second store loads the board last-per-subject, then follows live", async () => {
		const opts = names();
		const w1 = await store(opts);
		const a = await w1.create("ann", { title: "a" });
		await w1.setLabels(a.id, "ann", [queueLabel("be")]);
		const b = await w1.create("ann", { title: "b", priority: 0 });
		await w1.close(b.id, "ann", "done");
		const w2 = await store(opts);
		expect(await w2.head()).toBe(4);
		const board = await w2.board();
		expect(board.map((x) => [x.id, x.status])).toEqual([
			[b.id, "closed"],
			[a.id, "open"],
		]);
		expect((await w2.ready("be")).map((x) => x.id)).toEqual([a.id]);
		const seen: BeadEvent[] = [];
		w2.subscribe((e) => seen.push(e));
		const t0 = performance.now();
		const c = await w1.create("ann", { title: "c" });
		await w2.waitFor(4, 2_000);
		const ms = performance.now() - t0;
		expect(seen.map((e) => e.beadId)).toEqual([c.id]);
		expect(ms).toBeLessThan(1_000);
		expect((await w2.unrouted()).map((x) => x.id)).toEqual([c.id]);
	});

	test("closed items leave the board after doneForMs, but stay readable", async () => {
		let t = new Date("2026-11-10T10:00:00Z");
		const w = await store({ now: () => t, doneForMs: 60_000 });
		const a = await w.create("ann", { title: "a" });
		await w.close(a.id, "ann", "done");
		await w.waitFor(1, 2_000);
		expect((await w.board()).length).toBe(1);
		t = new Date(t.getTime() + 61_000);
		expect(await w.board()).toEqual([]);
		expect((await w.get(a.id)).status).toBe("closed");
		expect((await w.journalOf(a.id)).length).toBe(2);
	});

	test("stream settings: file, max_bytes with discard new; an existing stream is updated", async () => {
		const opts = names();
		const w = await store({ ...opts, maxBytes: 1024 * 1024 });
		expect(await w.usage()).toMatchObject({ maxBytes: 1024 * 1024 });
		const w2 = await store({ ...opts, maxBytes: 2048 });
		expect((await w2.usage()).maxBytes).toBe(2048);
		await w2.create("ann", { title: "a" });
		// Full: the write is refused, nothing old is deleted.
		await expect(
			w2.create("ann", { title: "b", description: "x".repeat(4096) }),
		).rejects.toThrow();
		expect((await w2.journalSince(0)).length).toBe(1);
	});

	test("reopen; unknown and malformed ids are NotFound", async () => {
		const w = await store();
		const a = await w.create("ann", { title: "a" });
		await w.claim(a.id, "ann/x");
		await w.close(a.id, "ann/x", "r");
		const re = await w.reopen(a.id, "ann");
		expect(re.status).toBe("open");
		expect(re.assignee).toBeUndefined();
		expect(re.closeReason).toBeUndefined();
		expect(w.get("mm-none")).rejects.toBeInstanceOf(NotFound);
		expect(w.get("a.b")).rejects.toBeInstanceOf(NotFound);
		expect(w.comment("mm-none", "ann", "x")).rejects.toBeInstanceOf(NotFound);
	});
});
