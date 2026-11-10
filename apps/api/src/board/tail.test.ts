import { expect, test } from "bun:test";
import type { BeadEvent } from "@mastermind/core";
import { type JournalSource, tailJournal } from "./tail.ts";

function ev(seq: number): BeadEvent {
	return {
		seq,
		at: "2026-11-10T00:00:00.000Z",
		op: "update",
		beadId: "b",
		actor: "a",
	};
}

/** A journal that grows: each poll may append the next batch. */
function journal(batches: number[][]) {
	const all: BeadEvent[] = [];
	const cursors: number[] = [];
	const source: JournalSource = {
		async journalSince(seq) {
			cursors.push(seq);
			const next = batches.shift();
			if (next) all.push(...next.map(ev));
			return all.filter((e) => e.seq > seq).slice(0, 2);
		},
	};
	return { source, cursors };
}

test("yields in seq order from the cursor and resumes after each page", async () => {
	const { source, cursors } = journal([[3, 4, 5], [], [6]]);
	const ac = new AbortController();
	const seen: number[] = [];
	for await (const e of tailJournal(source, {
		since: 2,
		intervalMs: 1,
		signal: ac.signal,
	})) {
		seen.push(e.seq);
		if (e.seq === 6) ac.abort();
	}
	expect(seen).toEqual([3, 4, 5, 6]);
	// pages of 2, read back to back while there is a backlog: 3,4 then 5 then 6
	expect(cursors.slice(0, 3)).toEqual([2, 4, 5]);
});

test("drops records at or below the cursor and sorts a page", async () => {
	const pages: BeadEvent[][] = [[ev(2), ev(1), ev(3)], []];
	const ac = new AbortController();
	const source: JournalSource = {
		async journalSince() {
			const page = pages.shift() ?? [];
			if (pages.length === 0) ac.abort();
			return page;
		},
	};
	const seen: number[] = [];
	for await (const e of tailJournal(source, {
		since: 1,
		intervalMs: 1,
		signal: ac.signal,
	})) {
		seen.push(e.seq);
	}
	expect(seen).toEqual([2, 3]);
});

test("abort during the idle sleep ends the tail promptly", async () => {
	const ac = new AbortController();
	const source: JournalSource = { journalSince: async () => [] };
	const started = performance.now();
	setTimeout(() => ac.abort(), 10);
	const seen: BeadEvent[] = [];
	for await (const e of tailJournal(source, {
		intervalMs: 60_000,
		signal: ac.signal,
	})) {
		seen.push(e);
	}
	expect(seen).toEqual([]);
	expect(performance.now() - started).toBeLessThan(1000);
});

test("an already aborted signal never reads", async () => {
	let reads = 0;
	const source: JournalSource = {
		journalSince: async () => {
			reads++;
			return [];
		},
	};
	for await (const _ of tailJournal(source, { signal: AbortSignal.abort() })) {
		// unreachable
	}
	expect(reads).toBe(0);
});
