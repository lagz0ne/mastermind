import { describe, expect, test } from "bun:test";
import type {
	ActivityPage,
	Bead,
	BeadComment,
	BeadDetail,
	BeadEvent,
} from "@mastermind/core";
import { type CreateBead, NotFound } from "@mastermind/work";
import { envOf } from "./env.ts";
import { type BeadsStore, beadsRoutes, parseNewWork } from "./routes.ts";

const at = "2026-11-10T08:00:00.000Z";

/** An in-memory store: every write appends to the journal, like the work store does. */
class FakeStore implements BeadsStore {
	beads = new Map<string, Bead>();
	journal: BeadEvent[] = [];
	extraComments: BeadComment[] = [];
	writes: { op: string; actor: string; arg?: unknown }[] = [];

	#append(op: string, actor: string, bead: Bead, comment?: BeadComment) {
		this.beads.set(bead.id, bead);
		this.journal.push({
			seq: this.journal.length + 1,
			at,
			op,
			beadId: bead.id,
			actor,
			bead,
			...(comment ? { comment } : {}),
		});
	}
	#must(id: string): Bead {
		const b = this.beads.get(id);
		if (!b) throw new NotFound({ status: 404, title: "x", code: "not_found" });
		return b;
	}
	async create(actor: string, input: CreateBead) {
		this.writes.push({ op: "create", actor, arg: input });
		const bead: Bead = {
			id: `mm-${this.beads.size + 1}`,
			title: input.title,
			status: "open",
			priority: input.priority ?? 2,
			type: input.type ?? "task",
			labels: input.labels ?? [],
			blocked: false,
			createdAt: at,
			updatedAt: at,
		};
		this.#append("create", actor, bead);
		return bead;
	}
	async get(id: string) {
		return this.#must(id);
	}
	async comment(id: string, actor: string, text: string) {
		const c = {
			id: `c${this.journal.length}`,
			beadId: id,
			author: actor,
			text,
			createdAt: at,
		};
		this.#append("comment", actor, this.#must(id), c);
		return c;
	}
	async close(id: string, actor: string, reason?: string) {
		this.writes.push({ op: "close", actor, arg: reason });
		const b: Bead = {
			...this.#must(id),
			status: "closed",
			closeReason: reason,
		};
		this.#append("close", actor, b);
		return b;
	}
	async reopen(id: string, actor: string, reason?: string) {
		this.writes.push({ op: "reopen", actor, arg: reason });
		const b: Bead = { ...this.#must(id), status: "open" };
		this.#append("update", actor, b);
		return b;
	}
	/** A runner's claim, as the dispatcher writes it. */
	claim(id: string, actor: string) {
		this.#append("update", actor, {
			...this.#must(id),
			status: "in_progress",
			assignee: actor,
			lease: { expiresAt: at, heartbeatAt: at },
		});
	}
	async head() {
		return this.journal.length;
	}
	async journalOf(id: string) {
		return this.journal.filter((e) => e.beadId === id);
	}
	async journalRecent(limit: number, before?: number) {
		return this.journal
			.filter((e) => before === undefined || e.seq < before)
			.reverse()
			.slice(0, limit);
	}
	async comments(id: string) {
		const fromJournal = this.journal
			.filter((e) => e.beadId === id && e.comment)
			.map((e) => e.comment as BeadComment);
		return [...this.extraComments, ...fromJournal];
	}
}

const asAccount = (account: string) => async () => account;

function setup(account: string | Response = "duke") {
	const store = new FakeStore();
	const routes = beadsRoutes(store, {
		requireAccount: async () => account,
	});
	return { store, routes };
}

function req(method: string, path: string, body?: unknown, id?: string) {
	const r = new Request(`http://mm.test${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}) as Request & { params?: Record<string, string> };
	if (id) r.params = { id };
	return r;
}

describe("POST /api/beads", () => {
	test("creates as the session account, env becomes labels the dispatcher reads", async () => {
		const { store, routes } = setup();
		const res = await routes["/api/beads"].POST(
			req("POST", "/api/beads", {
				title: "  Fix login  ",
				description: "d",
				acceptance: "a",
				type: "bug",
				priority: 1,
				labels: ["queue:build"],
				env: {
					repo: "https://github.com/x/y.git",
					ref: "dev",
					provider: "claude",
					requires: ["bun"],
				},
			}),
		);
		expect(res.status).toBe(201);
		const bead = (await res.json()) as Bead;
		expect(store.writes[0]).toMatchObject({
			op: "create",
			actor: "duke",
			arg: {
				title: "Fix login",
				description: "d",
				acceptance: "a",
				type: "bug",
				priority: 1,
			},
		});
		expect(envOf(bead)).toEqual({
			repo: "https://github.com/x/y.git",
			ref: "dev",
			provider: "claude",
			requires: ["bun"],
		});
		expect(bead.labels).toContain("queue:build");
	});

	test("defaults: task, P2, no labels; ref main when env has none", () => {
		expect(parseNewWork({ title: "t" })).toEqual({
			title: "t",
			type: "task",
			priority: 2,
			labels: [],
		});
		expect(
			envOf({
				labels: parseNewWork({ title: "t", env: { repo: "r" } }).labels ?? [],
			}),
		).toEqual({ repo: "r", ref: "main", requires: [] });
	});

	test("refuses bad input with 400", async () => {
		const { routes, store } = setup();
		for (const b of [
			{},
			{ title: " " },
			{ title: "t", priority: 7 },
			{ title: "t", type: "nope" },
			{ title: "t", labels: ["a b"] },
			{ title: "t", env: { ref: "x" } },
		]) {
			const res = await routes["/api/beads"].POST(req("POST", "/api/beads", b));
			expect(res.status).toBe(400);
		}
		expect(store.writes).toEqual([]);
	});

	test("no session: the guard's answer, nothing written", async () => {
		const { routes, store } = setup(
			Response.json({ error: "x" }, { status: 401 }),
		);
		const res = await routes["/api/beads"].POST(
			req("POST", "/api/beads", { title: "t" }),
		);
		expect(res.status).toBe(401);
		expect(store.writes).toEqual([]);
	});
});

describe("GET /api/beads/:id", () => {
	test("bead + timeline from the journal, older comments first", async () => {
		const { store, routes } = setup();
		const bead = await store.create("duke", {
			title: "t",
			labels: ["queue:build"],
		});
		store.claim(bead.id, "acc/r1");
		await store.comment(bead.id, "acc/r1", "halfway");
		await store.close(bead.id, "acc/r1", "done: PR #1");
		store.extraComments.push({
			id: "old",
			beadId: bead.id,
			author: "duke",
			text: "from before the journal",
			createdAt: at,
		});
		const res = await routes["/api/beads/:id"].GET(
			req("GET", `/api/beads/${bead.id}`, undefined, bead.id),
		);
		const detail = (await res.json()) as BeadDetail;
		expect(detail.seq).toBe(4);
		expect(detail.bead.status).toBe("closed");
		expect(
			detail.timeline.map((e) => [e.kind, e.text ?? e.holder ?? ""]),
		).toEqual([
			["note", "from before the journal"],
			["created", ""],
			["claimed", "acc/r1"],
			["report", "halfway"],
			["completed", "done: PR #1"],
		]);
		expect(detail.fold.bead?.status).toBe("closed");
	});

	test("unknown bead: 404", async () => {
		const { routes } = setup();
		const res = await routes["/api/beads/:id"].GET(
			req("GET", "/api/beads/nope", undefined, "nope"),
		);
		expect(res.status).toBe(404);
	});
});

describe("notes, reopen, close, activity", () => {
	test("each write is by the session account", async () => {
		const { store, routes } = setup("ann");
		const { id } = await store.create("ann", { title: "t" });
		const note = await routes["/api/beads/:id/comments"].POST(
			req("POST", "", { text: "use bun" }, id),
		);
		expect(note.status).toBe(201);
		expect(((await note.json()) as BeadComment).author).toBe("ann");
		expect(
			(
				await routes["/api/beads/:id/comments"].POST(
					req("POST", "", { text: "" }, id),
				)
			).status,
		).toBe(400);
		await routes["/api/beads/:id/close"].POST(req("POST", "", {}, id));
		await routes["/api/beads/:id/reopen"].POST(
			req("POST", "", { reason: "again" }, id),
		);
		expect(store.writes.slice(1)).toEqual([
			{ op: "close", actor: "ann", arg: "closed by ann" },
			{ op: "reopen", actor: "ann", arg: "again" },
		]);
	});

	test("activity is newest first, pages with before, caps limit", async () => {
		const { store, routes } = setup();
		for (let i = 0; i < 5; i++) await store.create("duke", { title: `t${i}` });
		const page = (await (
			await routes["/api/activity"].GET(
				req("GET", "/api/activity?limit=2&before=4"),
			)
		).json()) as ActivityPage;
		expect(page.head).toBe(5);
		expect(page.events.map((e) => e.seq)).toEqual([3, 2]);
	});

	test("no work store: 503 once the session is good", async () => {
		const routes = beadsRoutes(null, { requireAccount: asAccount("duke") });
		const res = await routes["/api/activity"].GET(req("GET", "/api/activity"));
		expect(res.status).toBe(503);
	});
});
