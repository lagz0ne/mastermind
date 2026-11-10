import { expect, test } from "bun:test";
import type { Lease } from "@mastermind/core";
import { type LeaseChange, LeaseWatch } from "./leases.ts";

const lease = (hb: string): Lease => ({
	heartbeatAt: hb,
	expiresAt: `${hb}+5m`,
});

test("first poll is the baseline; then renewals, new claims and releases are changes", async () => {
	let rows = [{ beadId: "mm-1", lease: lease("t0") }];
	const watch = new LeaseWatch({ leases: async () => rows });
	const seen: LeaseChange[] = [];
	const off = watch.subscribe((c) => seen.push(c));
	await watch.poll();
	expect(seen).toEqual([]);
	await watch.poll();
	expect(seen).toEqual([]);
	rows = [
		{ beadId: "mm-1", lease: lease("t1") },
		{ beadId: "mm-2", lease: lease("t1") },
	];
	await watch.poll();
	rows = [{ beadId: "mm-2", lease: lease("t1") }];
	await watch.poll();
	expect(seen).toEqual([
		{ beadId: "mm-1", lease: lease("t1") },
		{ beadId: "mm-2", lease: lease("t1") },
		{ beadId: "mm-1" },
	]);
	off();
	expect(watch.listeners).toBe(0);
});

test("polls on its own while someone listens, and stops after", async () => {
	let polls = 0;
	const watch = new LeaseWatch(
		{
			leases: async () => {
				polls++;
				return [];
			},
		},
		{ intervalMs: 5 },
	);
	const off = watch.subscribe(() => {});
	await Bun.sleep(40);
	off();
	const after = polls;
	expect(after).toBeGreaterThan(2);
	await Bun.sleep(30);
	expect(polls).toBe(after);
});

test("a failing read is reported, not thrown", async () => {
	const errors: unknown[] = [];
	const watch = new LeaseWatch(
		{
			leases: async () => {
				throw new Error("dolt down");
			},
		},
		{ onError: (e) => errors.push(e) },
	);
	await watch.poll();
	expect(errors).toHaveLength(1);
});
