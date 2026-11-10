import { describe, expect, test } from "bun:test";
import { NotFound } from "@mastermind/beads";
import { BusError, type StoreEntry } from "@mastermind/bus";
import type { Bead } from "@mastermind/core";
import { explain, queuesOf, ROUTING_KEY, validate } from "./model.ts";
import { type RoutingBeads, routingRoutes } from "./routes.ts";
import { type RoutingKv, RoutingStore, StaleRevision } from "./store.ts";

/** In-memory KV with JetStream's compare-and-set rules. */
export function memoryKv(): RoutingKv & { writes: number } {
	const map = new Map<string, { value: unknown; revision: number }>();
	let seq = 0;
	return {
		writes: 0,
		async get(key) {
			const e = map.get(key);
			return e ? ({ key, ...structuredClone(e) } as StoreEntry<unknown>) : null;
		},
		async create(key, value) {
			if (map.has(key)) throw new BusError("conflict", "exists");
			map.set(key, { value: structuredClone(value), revision: ++seq });
			this.writes++;
			return seq;
		},
		async update(key, value, revision) {
			if (map.get(key)?.revision !== revision)
				throw new BusError("conflict", "wrong last sequence");
			map.set(key, { value: structuredClone(value), revision: ++seq });
			this.writes++;
			return seq;
		},
	};
}

const DOC = {
	queues: [
		{ name: "backend", description: "API work", members: ["alice"] },
		{
			name: "web",
			description: "",
			members: ["bob", "alice"],
			maxPerAccount: 2,
		},
	],
	rules: [
		{ match: { labels: ["area:api"] }, queue: "backend" },
		{ match: { type: "bug", maxPriority: 1 }, queue: "web" },
		{ match: {}, queue: "web" },
	],
};

const bead = (over: Partial<Bead> = {}): Bead => ({
	id: "mm-1",
	title: "t",
	status: "open",
	priority: 2,
	type: "task",
	labels: [],
	blocked: false,
	createdAt: "2026-11-10T00:00:00Z",
	updatedAt: "2026-11-10T00:00:00Z",
	...over,
});

describe("validate", () => {
	test("a good document passes and keeps rule order", () => {
		const v = validate(DOC);
		expect(v.ok).toBe(true);
		if (v.ok)
			expect(v.doc.rules.map((r) => r.queue)).toEqual([
				"backend",
				"web",
				"web",
			]);
	});

	test("a rule must name an existing queue; names are subject tokens", () => {
		const v = validate({
			queues: [
				{ name: "a.b", members: [] },
				{ name: "ok", members: ["Bad Id"] },
			],
			rules: [
				{ match: {}, queue: "nope" },
				{ match: { color: "red" }, queue: "ok" },
			],
		});
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.errors.join("\n")).toContain("queue 1: name must be");
			expect(v.errors.join("\n")).toContain("ok: members must be account ids");
			expect(v.errors.join("\n")).toContain(
				'rule 1: queue "nope" does not exist',
			);
			expect(v.errors.join("\n")).toContain(
				"rule 2: unknown match field color",
			);
		}
	});

	test("duplicate queue names and bad numbers are refused", () => {
		const v = validate({
			queues: [
				{ name: "a", members: [], maxPerAccount: 0 },
				{ name: "a", members: [] },
			],
			rules: [{ match: { maxPriority: 7 }, queue: "a" }],
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.errors).toHaveLength(3);
	});
});

describe("explain", () => {
	const doc = validate(DOC);
	if (!doc.ok) throw new Error("bad fixture");
	test("first matching rule wins", () => {
		expect(
			explain(
				bead({ labels: ["area:api"], type: "bug", priority: 0 }),
				doc.doc,
			),
		).toMatchObject({
			queue: "backend",
			ruleIndex: 0,
		});
		expect(explain(bead({ type: "bug", priority: 1 }), doc.doc)).toMatchObject({
			queue: "web",
			ruleIndex: 1,
		});
	});
	test("a queue label wins over every rule", () => {
		const e = explain(bead({ labels: ["area:api", "queue:web"] }), doc.doc);
		expect(e).toMatchObject({ queue: "web", ruleIndex: null });
		expect(e.why).toContain("queue:web");
	});
	test("no rule: unrouted", () => {
		expect(explain(bead(), { queues: [], rules: [] })).toMatchObject({
			queue: null,
			ruleIndex: null,
		});
	});
	test("queuesOf lists the queues of an account", () => {
		expect(queuesOf(doc.doc, "alice")).toEqual(["backend", "web"]);
		expect(queuesOf(doc.doc, "bob")).toEqual(["web"]);
		expect(queuesOf(doc.doc, "carol")).toEqual([]);
	});
});

describe("RoutingStore", () => {
	test("first write at revision 0, then compare-and-set", async () => {
		const store = new RoutingStore(memoryKv());
		expect(await store.read()).toEqual({
			doc: { queues: [], rules: [] },
			revision: 0,
		});
		const v = validate(DOC);
		if (!v.ok) throw new Error();
		const a = await store.write(v.doc, 0);
		expect(a.revision).toBeGreaterThan(0);
		const stale = store.write(v.doc, 0);
		expect(stale).rejects.toBeInstanceOf(StaleRevision);
		const b = await store.write({ ...v.doc, rules: [] }, a.revision);
		expect((await store.read()).revision).toBe(b.revision);
	});
});

function setup(account: string | Response = "alice") {
	const kv = memoryKv();
	const store = new RoutingStore(kv);
	const beads = new Map<string, Bead>([
		["mm-7", bead({ id: "mm-7", labels: ["area:api", "x"] })],
	]);
	const writes: { id: string; actor: string; labels: string[] }[] = [];
	const bd: RoutingBeads = {
		async get(id) {
			const b = beads.get(id);
			if (!b)
				throw new NotFound({
					status: 404,
					title: "not_found",
					code: "not_found",
				});
			return structuredClone(b);
		},
		async setLabels(id, actor, labels) {
			writes.push({ id, actor, labels });
			const b = { ...(beads.get(id) as Bead), labels };
			beads.set(id, b);
			return b;
		},
	};
	const routes = routingRoutes({
		store: () => store,
		beads: bd,
		requireAccount: async () => account,
	});
	return { kv, store, routes, writes, beads };
}

const send = (
	method: string,
	body?: unknown,
	params?: Record<string, string>,
) => {
	const req = new Request("https://mm.example/api/x", {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}) as Request & { params?: Record<string, string> };
	if (params) req.params = params;
	return req;
};

describe("routing routes", () => {
	test("the session check runs first", async () => {
		const { routes } = setup(
			Response.json({ error: "not logged in" }, { status: 401 }),
		);
		expect((await routes["/api/routing"].GET(send("GET"))).status).toBe(401);
		expect((await routes["/api/routing"].PUT(send("PUT", {}))).status).toBe(
			401,
		);
	});

	test("GET, PUT with revision, and a clear 409 on a stale write", async () => {
		const { routes } = setup();
		const first = await (await routes["/api/routing"].GET(send("GET"))).json();
		expect(first).toEqual({ queues: [], rules: [], revision: 0 });

		// Two browsers read revision 0; both save.
		const a = await routes["/api/routing"].PUT(
			send("PUT", { ...DOC, revision: 0 }),
		);
		const b = await routes["/api/routing"].PUT(
			send("PUT", { ...DOC, rules: [], revision: 0 }),
		);
		expect(a.status).toBe(200);
		expect(b.status).toBe(409);
		const conflict = (await b.json()) as {
			error: string;
			current: { revision: number; rules: unknown[] };
		};
		expect(conflict.error).toContain("somebody else saved routing first");
		expect(conflict.current.rules).toHaveLength(3);
		const saved = (await a.json()) as { revision: number };
		expect(conflict.current.revision).toBe(saved.revision);
	});

	test("PUT refuses a bad document with the reasons", async () => {
		const { routes } = setup();
		const res = await routes["/api/routing"].PUT(
			send("PUT", {
				queues: [],
				rules: [{ match: {}, queue: "ghost" }],
				revision: 0,
			}),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: string[] }).errors[0]).toContain(
			"ghost",
		);
		const noRev = await routes["/api/routing"].PUT(send("PUT", DOC));
		expect(noRev.status).toBe(400);
	});

	test("try a bead: by id or by sketch", async () => {
		const { routes } = setup();
		await routes["/api/routing"].PUT(send("PUT", { ...DOC, revision: 0 }));
		const byId = await routes["/api/routing/test"].POST(
			send("POST", { beadId: "mm-7" }),
		);
		expect(await byId.json()).toMatchObject({ queue: "backend", ruleIndex: 0 });
		const bySketch = await routes["/api/routing/test"].POST(
			send("POST", { bead: { type: "bug", priority: 0, labels: [] } }),
		);
		expect(await bySketch.json()).toMatchObject({ queue: "web", ruleIndex: 1 });
		const missing = await routes["/api/routing/test"].POST(
			send("POST", { beadId: "mm-404" }),
		);
		expect(missing.status).toBe(404);
	});

	test("manual move: replaces the queue label, as the account; null removes it", async () => {
		const { routes, writes, beads } = setup();
		await routes["/api/routing"].PUT(send("PUT", { ...DOC, revision: 0 }));
		const move = routes["/api/beads/:id/queue"].POST;
		const r1 = await move(send("POST", { queue: "web" }, { id: "mm-7" }));
		expect(r1.status).toBe(200);
		expect(beads.get("mm-7")?.labels).toEqual(["area:api", "x", "queue:web"]);
		await move(send("POST", { queue: "backend" }, { id: "mm-7" }));
		expect(beads.get("mm-7")?.labels).toEqual([
			"area:api",
			"x",
			"queue:backend",
		]);
		await move(send("POST", { queue: null }, { id: "mm-7" }));
		expect(beads.get("mm-7")?.labels).toEqual(["area:api", "x"]);
		expect(writes.every((w) => w.actor === "alice")).toBe(true);
		const ghost = await move(send("POST", { queue: "ghost" }, { id: "mm-7" }));
		expect(ghost.status).toBe(400);
		expect(writes).toHaveLength(3);
	});

	test("503 while the store is not ready", async () => {
		const routes = routingRoutes({
			store: () => null,
			beads: null,
			requireAccount: async () => "alice",
		});
		expect((await routes["/api/routing"].GET(send("GET"))).status).toBe(503);
	});

	test("the document lives at one key", () => {
		expect(ROUTING_KEY).toBe("routing");
	});
});
