import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
	type BoardRow,
	DoltReader,
	type JournalRow,
	type SqlTag,
} from "./dolt.ts";
import boardRows from "./fixtures/dolt/board-rows.json";
import journalRows from "./fixtures/dolt/journal-rows.json";

/** Bun's mysql adapter returns DATETIME as Date; the recording has strings. */
function revive<T>(rows: Record<string, unknown>[]): T[] {
	return rows.map((r) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(r)) {
			out[k] =
				typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)
					? new Date(v)
					: v;
		}
		return out as T;
	});
}

function fakeSql(rows: unknown[]) {
	const calls: { text: string; values: unknown[] }[] = [];
	const sql: SqlTag = async (strings, ...values) => {
		calls.push({ text: strings.join("?"), values });
		return rows;
	};
	return { sql, calls };
}

test("board is one query and maps labels, blocked flag and lease", async () => {
	const { sql, calls } = fakeSql(revive<BoardRow>(boardRows));
	const since = new Date("2026-11-03T00:00:00Z");
	const beads = await new DoltReader(sql).board({ doneSince: since });

	expect(calls).toHaveLength(1);
	expect(calls[0]?.values).toEqual([since]);
	expect(calls[0]?.text).toContain("from issues i");
	expect(calls[0]?.text).toContain("left join leases");

	expect(beads.map((b) => b.id)).toEqual([
		"pr-pkn",
		"pr-2ic",
		"pr-a4o",
		"pr-x1u",
	]);
	const [done, claimed, blocked, ready] = beads;
	expect(done).toMatchObject({
		status: "closed",
		closedAt: "2026-11-10T05:44:53.000Z",
	});
	expect(done && "assignee" in done).toBe(false);
	expect(claimed).toMatchObject({
		status: "in_progress",
		assignee: "alice/agent-1",
		labels: ["queue:alice"],
		lease: {
			expiresAt: "2026-11-10T05:39:28.000Z",
			heartbeatAt: "2026-11-10T05:34:28.000Z",
		},
	});
	expect(blocked).toMatchObject({ blocked: true, labels: [] });
	expect(blocked && "description" in blocked).toBe(false);
	expect(ready).toMatchObject({
		blocked: false,
		labels: ["env:bun", "queue:bob"],
	});
	expect(ready?.lease).toBeUndefined();
});

test("board accepts labels as a raw JSON string or null", async () => {
	const [row] = revive<BoardRow>(boardRows);
	if (!row) throw new Error("fixture is empty");
	const { sql } = fakeSql([
		{ ...row, id: "a", labels: '["queue:z","a"]' },
		{ ...row, id: "b", labels: null },
	]);
	const [a, b] = await new DoltReader(sql).board();
	expect(a?.labels).toEqual(["a", "queue:z"]);
	expect(b?.labels).toEqual([]);
});

test("journalSince passes the cursor and parses issue_json", async () => {
	const { sql, calls } = fakeSql(revive<JournalRow>(journalRows));
	const events = await new DoltReader(sql).journalSince(9, 50);
	expect(calls[0]?.values).toEqual([9, 50]);
	expect(calls[0]?.text).toContain("from bd_events_journal");
	expect(events.map((e) => [e.seq, e.op])).toEqual([
		[10, "close"],
		[11, "comment"],
		[12, "dep_add"],
	]);
	expect(events[0]).toMatchObject({
		beadId: "pr-pkn",
		actor: "alice/agent1",
		at: "2026-11-10T05:44:53.000Z",
		bead: { status: "closed", labels: ["queue:build"] },
	});
	expect(events[2]?.bead?.blocked).toBe(true);
});

test("a journal row without issue_json has no bead", async () => {
	const { sql } = fakeSql([
		{
			seq: 13n,
			ts: new Date(0),
			op: "delete",
			issue_id: "x",
			actor: null,
			issue_json: null,
		},
	]);
	const [event] = await new DoltReader(sql).journalSince(12);
	expect(event).toEqual({
		seq: 13,
		at: "1970-01-01T00:00:00.000Z",
		op: "delete",
		beadId: "x",
		actor: "",
	});
});

test("a Bun SQL instance is a SqlTag", () => {
	// Compile-time check: DoltReader takes `new SQL("mysql://...")` as is.
	const asTag = (sql: SQL): SqlTag => sql;
	expect(typeof asTag).toBe("function");
});
