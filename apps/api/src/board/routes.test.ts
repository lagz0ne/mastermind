import { afterEach, describe, expect, test } from "bun:test";
import type { Bead, BeadEvent, BoardSnapshot } from "@mastermind/core";
import {
	type BoardRoutes,
	type BoardSource,
	boardRoutes,
	parseSeq,
} from "./routes.ts";

const bead = (id: string, title = id): Bead => ({
	id,
	title,
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: "2026-11-10T00:00:00.000Z",
	updatedAt: "2026-11-10T00:00:00.000Z",
});

/** An in-memory journal: `append` is a bd write. */
class FakeSource implements BoardSource {
	journal: BeadEvent[] = [];
	beads = new Map<string, Bead>();
	reads = 0;

	append(id: string, op = "create"): BeadEvent {
		const event: BeadEvent = {
			seq: this.journal.length + 1,
			at: new Date().toISOString(),
			op,
			beadId: id,
			actor: "test",
			bead: bead(id),
		};
		this.journal.push(event);
		this.beads.set(id, bead(id));
		return event;
	}
	async board() {
		return [...this.beads.values()];
	}
	async head() {
		return this.journal.length;
	}
	async journalSince(seq: number) {
		this.reads++;
		return this.journal.filter((e) => e.seq > seq).slice(0, 2);
	}
}

/** Reads SSE frames off a response body. */
function sseReader(res: Response) {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		async next(): Promise<{ id: number; event: BeadEvent }> {
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end >= 0) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const id = /^id: (\d+)$/m.exec(frame)?.[1];
					const data = /^data: (.*)$/m.exec(frame)?.[1];
					if (id && data) return { id: Number(id), event: JSON.parse(data) };
					continue; // retry: or keep-alive comment
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buffer += decoder.decode(value, { stream: true });
			}
		},
		cancel: () => reader.cancel(),
	};
}

const get = (path: string, headers: Record<string, string> = {}) =>
	new Request(`http://test${path}`, { headers });

let open: BoardRoutes[] = [];
afterEach(() => {
	for (const r of open) r.stop();
	open = [];
});

function setup() {
	const source = new FakeSource();
	const board = boardRoutes(source, { intervalMs: 5, retryMs: 5 });
	open.push(board);
	return { source, ...board.routes, board };
}

describe("parseSeq", () => {
	test("accepts non-negative integers only", () => {
		expect(parseSeq("12")).toBe(12);
		expect(parseSeq(" 0 ")).toBe(0);
		expect(parseSeq(null)).toBeNull();
		expect(parseSeq("-1")).toBeNull();
		expect(parseSeq("x")).toBeNull();
	});
});

describe("without Dolt", () => {
	test("both routes answer 503 with a clear body", async () => {
		const { routes } = boardRoutes(null);
		for (const res of [
			await routes["/api/board"](get("/api/board")),
			await routes["/api/events"](get("/api/events")),
		]) {
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: "dolt unconfigured" });
		}
	});
});

describe("GET /api/board", () => {
	test("returns columns, beads and the journal head, with an ETag", async () => {
		const { source, "/api/board": board } = setup();
		source.append("mm-1");
		source.append("mm-2");
		const res = await board(get("/api/board"));
		expect(res.status).toBe(200);
		expect(res.headers.get("etag")).toBe('"2"');
		const body = (await res.json()) as BoardSnapshot;
		expect(body.seq).toBe(2);
		expect(body.columns).toEqual(["ready", "in_progress", "blocked", "done"]);
		expect(body.beads.map((b) => b.id)).toEqual(["mm-1", "mm-2"]);
	});

	test("answers 304 while the journal head is unchanged", async () => {
		const { source, "/api/board": board } = setup();
		source.append("mm-1");
		const fresh = await board(get("/api/board", { "if-none-match": '"1"' }));
		expect(fresh.status).toBe(304);
		source.append("mm-2");
		const stale = await board(get("/api/board", { "if-none-match": '"1"' }));
		expect(stale.status).toBe(200);
	});

	test("answers 503 when Dolt fails", async () => {
		const { source, "/api/board": board } = setup();
		source.head = async () => {
			throw new Error("connection refused");
		};
		const res = await board(get("/api/board"));
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ error: "dolt unavailable" });
	});
});

describe("GET /api/events", () => {
	test("is an SSE stream", async () => {
		const { "/api/events": events } = setup();
		const res = await events(get("/api/events"));
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		await res.body?.cancel();
	});

	test("fans one tail out to every client", async () => {
		const { source, board, "/api/events": events } = setup();
		const a = sseReader(await events(get("/api/events?since=0")));
		const b = sseReader(await events(get("/api/events?since=0")));
		source.append("mm-1");
		source.append("mm-2");
		for (const client of [a, b]) {
			expect((await client.next()).id).toBe(1);
			const second = await client.next();
			expect(second.id).toBe(2);
			expect(second.event.bead?.id).toBe("mm-2");
		}
		// The same tail serves both clients.
		expect(board.hub?.tails).toBe(1);
		await a.cancel();
		await b.cancel();
	});

	test("without a cursor it starts at the head (no history)", async () => {
		const { source, "/api/events": events } = setup();
		source.append("mm-old");
		const client = sseReader(await events(get("/api/events")));
		source.append("mm-new");
		const { id, event } = await client.next();
		expect(id).toBe(2);
		expect(event.beadId).toBe("mm-new");
		await client.cancel();
	});

	test("resumes from Last-Event-ID, ahead of ?since, without gaps or repeats", async () => {
		const { source, "/api/events": events } = setup();
		for (const id of ["mm-1", "mm-2", "mm-3", "mm-4", "mm-5"])
			source.append(id);
		const client = sseReader(
			await events(get("/api/events?since=0", { "last-event-id": "2" })),
		);
		source.append("mm-6");
		const seen: number[] = [];
		for (let i = 0; i < 4; i++) seen.push((await client.next()).id);
		expect(seen).toEqual([3, 4, 5, 6]);
		await client.cancel();
	});

	test("a client that joins a running tail misses nothing", async () => {
		const { source, board, "/api/events": events } = setup();
		const a = sseReader(await events(get("/api/events?since=0")));
		for (const id of ["mm-1", "mm-2", "mm-3"]) source.append(id);
		for (let i = 0; i < 3; i++) await a.next();
		const b = sseReader(await events(get("/api/events?since=1")));
		source.append("mm-4");
		const seen: number[] = [];
		for (let i = 0; i < 3; i++) seen.push((await b.next()).id);
		expect(seen).toEqual([2, 3, 4]);
		expect((await a.next()).id).toBe(4);
		expect(board.hub?.tails).toBe(1);
		await a.cancel();
		await b.cancel();
	});

	test("the tail stops when the last client leaves", async () => {
		const { board, "/api/events": events } = setup();
		const res = await events(get("/api/events?since=0"));
		expect(board.hub?.listeners).toBe(1);
		await res.body?.cancel();
		expect(board.hub?.listeners).toBe(0);
	});
});

describe("lease frames (heartbeats are not in the journal)", () => {
	test("a renewed lease reaches the stream as event: lease, without an id", async () => {
		const source = new FakeSource();
		let hb = "2026-11-10T08:00:00.000Z";
		const fake = source as FakeSource & BoardSource;
		fake.leases = async () => [
			{ beadId: "mm-1", lease: { heartbeatAt: hb, expiresAt: hb } },
		];
		const board = boardRoutes(source, {
			intervalMs: 5,
			retryMs: 5,
			leaseIntervalMs: 5,
		});
		open.push(board);
		const res = await board.routes["/api/events"](get("/api/events?since=0"));
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await Bun.sleep(20);
		hb = "2026-11-10T08:01:00.000Z";
		let text = "";
		while (!text.includes("event: lease")) {
			const { value } = await reader.read();
			text += new TextDecoder().decode(value);
		}
		const frame = text.slice(text.indexOf("event: lease")).split("\n\n")[0];
		expect(frame).not.toContain("id:");
		expect(frame).toContain('"beadId":"mm-1"');
		expect(frame).toContain(hb);
		await reader.cancel();
	});
});
