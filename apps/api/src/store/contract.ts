// The contract of a work store as the dispatcher uses it (Work). One suite,
// run against every implementation: the in-memory fake and the NATS store.
import { describe, expect, test } from "bun:test";
import { type Bead, leaseState, queueLabel } from "@mastermind/core";
import { AlreadyClaimed, type CreateBead, NotFound } from "@mastermind/work";
import type { Work } from "../dispatch/work.ts";

export type Clock = { now: () => Date; advance(ms: number): void };

export function clock(start = "2026-11-10T10:00:00Z"): Clock {
	let t = Date.parse(start);
	return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

/** A store under test with a way to add an item (the fake: add; NATS: create). */
export type Subject = {
	work: Work;
	add(input: CreateBead): Promise<Bead>;
	stop(): void | Promise<void>;
};

export type ContractOptions = {
	/** The lease term the store grants. */
	leaseMs: number;
	/** False where the implementation lets anyone release (the fake). */
	releaseChecksHolder?: boolean;
};

export function workContract(
	name: string,
	make: (clock: Clock) => Promise<Subject>,
	opts: ContractOptions,
): void {
	describe(`work contract: ${name}`, () => {
		const withSubject =
			(fn: (s: Subject, c: Clock) => Promise<void>) => async () => {
				const c = clock();
				const s = await make(c);
				try {
					await fn(s, c);
				} finally {
					await s.stop();
				}
			};

		test(
			"claim race: N parallel actors, exactly one winner",
			withSubject(async ({ work, add }) => {
				const b = await add({ title: "race", labels: [queueLabel("be")] });
				const actors = Array.from({ length: 8 }, (_, i) => `acct${i}/agent`);
				const results = await Promise.allSettled(
					actors.map((a) => work.claim(b.id, a)),
				);
				const won = results.filter((r) => r.status === "fulfilled");
				expect(won.length).toBe(1);
				for (const r of results) {
					if (r.status === "rejected")
						expect(r.reason).toBeInstanceOf(AlreadyClaimed);
				}
				const now = await work.get(b.id);
				expect(now.status).toBe("in_progress");
				expect(actors).toContain(now.assignee as string);
			}),
		);

		test(
			"the holder's second claim is a no-op that says so",
			withSubject(async ({ work, add }) => {
				const b = await add({ title: "x" });
				const first = await work.claim(b.id, "ann/a");
				expect(first.alreadyClaimed).toBe(false);
				const again = await work.claim(b.id, "ann/a");
				expect(again.alreadyClaimed).toBe(true);
				expect(again.bead.lease).toEqual(first.bead.lease);
			}),
		);

		test(
			"heartbeat extends the lease; only the holder may",
			withSubject(async ({ work, add }, c) => {
				const b = await add({ title: "x" });
				const { bead } = await work.claim(b.id, "ann/a");
				c.advance(opts.leaseMs / 2);
				const hb = await work.heartbeat(b.id, "ann/a");
				expect(Date.parse(hb.lease?.expiresAt ?? "")).toBe(
					c.now().getTime() + opts.leaseMs,
				);
				expect(Date.parse(hb.lease?.expiresAt ?? "")).toBeGreaterThan(
					Date.parse(bead.lease?.expiresAt ?? ""),
				);
				expect(work.heartbeat(b.id, "bob/b")).rejects.toThrow();
				c.advance(opts.leaseMs * 0.9);
				const [held] = await work.claimed();
				expect(leaseState(held?.lease, c.now())).toBe("live");
			}),
		);

		test(
			"an expired lease shows in claimed(); the sweep's release makes the item ready again",
			withSubject(async ({ work, add }, c) => {
				const b = await add({ title: "x", labels: [queueLabel("be")] });
				await work.claim(b.id, "ann/a");
				expect(await work.ready("be")).toEqual([]);
				c.advance(opts.leaseMs + 1);
				const claimed = await work.claimed();
				expect(claimed.map((x) => x.id)).toEqual([b.id]);
				expect(leaseState(claimed[0]?.lease, c.now())).toBe("expired");
				// What Dispatcher.sweep does: release as the holder.
				await work.release(b.id, claimed[0]?.assignee as string);
				expect((await work.ready("be")).map((x) => x.id)).toEqual([b.id]);
				expect(await work.claimed()).toEqual([]);
				const again = await work.claim(b.id, "bob/b");
				expect(again.bead.assignee).toBe("bob/b");
			}),
		);

		test(
			"release needs a claim, and only the holder may release",
			withSubject(async ({ work, add }) => {
				const b = await add({ title: "x" });
				expect(work.release(b.id, "ann/a")).rejects.toThrow();
				await work.claim(b.id, "ann/a");
				if (opts.releaseChecksHolder !== false) {
					expect(work.release(b.id, "bob/b")).rejects.toThrow();
					expect((await work.get(b.id)).assignee).toBe("ann/a");
				}
				const released = await work.release(b.id, "ann/a");
				expect(released.status).toBe("open");
				expect(released.assignee).toBeUndefined();
			}),
		);

		test(
			"setLabels replaces the whole set; ready and unrouted follow",
			withSubject(async ({ work, add }) => {
				const b = await add({ title: "x", labels: ["repo:a"] });
				expect((await work.unrouted()).map((x) => x.id)).toEqual([b.id]);
				const moved = await work.setLabels(b.id, "mastermind", [
					"repo:a",
					queueLabel("be"),
				]);
				expect(moved.labels.sort()).toEqual(["queue:be", "repo:a"]);
				expect(await work.unrouted()).toEqual([]);
				expect((await work.ready("be")).map((x) => x.id)).toEqual([b.id]);
				await work.setLabels(b.id, "mastermind", [queueLabel("fe")]);
				expect((await work.get(b.id)).labels).toEqual(["queue:fe"]);
				expect(await work.ready("be")).toEqual([]);
				expect((await work.ready("fe")).map((x) => x.id)).toEqual([b.id]);
			}),
		);

		test(
			"close takes the item off ready and claimed",
			withSubject(async ({ work, add }) => {
				const b = await add({ title: "x", labels: [queueLabel("be")] });
				await work.claim(b.id, "ann/a");
				const closed = await work.close(b.id, "ann/a", "result");
				expect(closed.status).toBe("closed");
				expect(closed.closedAt).toBeString();
				expect(await work.claimed()).toEqual([]);
				expect(await work.ready("be")).toEqual([]);
			}),
		);

		test(
			"unknown ids are NotFound",
			withSubject(async ({ work }) => {
				expect(work.get("mm-zzzz")).rejects.toBeInstanceOf(NotFound);
				expect(work.claim("mm-zzzz", "ann/a")).rejects.toBeInstanceOf(NotFound);
			}),
		);
	});
}
