import { describe, expect, test } from "bun:test";
import { BdClient } from "./client.ts";
import { AlreadyClaimed, BdError, NotFound } from "./errors.ts";
import claimed from "./fixtures/wire/claim.json";
import claim400 from "./fixtures/wire/claim-400-invalid-argument.json";
import claim409 from "./fixtures/wire/claim-409-already-claimed.json";
import claimHeartbeat from "./fixtures/wire/claim-heartbeat.json";
import closed from "./fixtures/wire/close.json";
import commented from "./fixtures/wire/comment.json";
import created from "./fixtures/wire/create.json";
import events from "./fixtures/wire/events.json";
import got from "./fixtures/wire/get.json";
import get404 from "./fixtures/wire/get-404-not-found.json";
import ready from "./fixtures/wire/ready.json";
import released from "./fixtures/wire/release.json";
import release409 from "./fixtures/wire/release-409-not-releasable.json";
import updated from "./fixtures/wire/update.json";

type Seen = { method: string; url: URL; headers: Headers; body: unknown };

/** A fetch that answers one recorded response and remembers the request. */
function fake(status: number, body: unknown, token?: string) {
	const seen: Seen[] = [];
	const client = new BdClient({
		baseUrl: "http://bd.test/",
		token,
		fetch: async (req) => {
			const text = await req.text();
			seen.push({
				method: req.method,
				url: new URL(req.url),
				headers: req.headers,
				body: text ? JSON.parse(text) : undefined,
			});
			return new Response(JSON.stringify(body), {
				status,
				headers: {
					"content-type":
						status < 300
							? "application/json; charset=utf-8"
							: "application/problem+json; charset=utf-8",
				},
			});
		},
	});
	return { client, seen };
}

describe("BdClient requests and mapping", () => {
	test("ready passes label and limit, maps items", async () => {
		const { client, seen } = fake(200, ready);
		const beads = await client.ready({ label: "queue:build", limit: 5 });
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.url.pathname).toBe("/v0/beads/ready");
		expect(seen[0]?.url.searchParams.get("label")).toBe("queue:build");
		expect(seen[0]?.url.searchParams.get("limit")).toBe("5");
		expect(beads).toEqual([
			{
				id: "pr-pkn",
				title: "Probe create",
				description: "made by mm-210.3",
				status: "open",
				priority: 2,
				type: "task",
				labels: ["queue:build"],
				blocked: false,
				createdAt: "2026-11-10T05:44:43.000Z",
				updatedAt: "2026-11-10T05:44:43.000Z",
			},
		]);
	});

	test("get maps the lease and assignee", async () => {
		const { client, seen } = fake(200, got);
		const bead = await client.get("pr-pkn");
		expect(seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn");
		expect(bead.status).toBe("in_progress");
		expect(bead.assignee).toBe("alice/agent1");
		expect(bead.priority).toBe(1);
		expect(bead.lease).toEqual({
			expiresAt: "2026-11-10T05:49:52.000Z",
			heartbeatAt: "2026-11-10T05:44:52.000Z",
		});
	});

	test("create sends issue_type and labels", async () => {
		const { client, seen } = fake(200, created);
		const bead = await client.create("alice/agent1", {
			title: "Probe create",
			description: "made by mm-210.3",
			priority: 2,
			type: "task",
			labels: ["queue:build"],
		});
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.url.pathname).toBe("/v0/beads/issues");
		expect(seen[0]?.body).toEqual({
			actor: "alice/agent1",
			title: "Probe create",
			description: "made by mm-210.3",
			priority: 2,
			issue_type: "task",
			labels: ["queue:build"],
		});
		expect(bead.id).toBe("pr-pkn");
		// bd echoes sub-second timestamps on create; they normalize the same way.
		expect(bead.createdAt).toBe("2026-11-10T05:44:42.968Z");
	});

	test("update sends a PATCH with actor and patch", async () => {
		const { client, seen } = fake(200, updated);
		const bead = await client.update("pr-pkn", "alice/agent1", {
			title: "Probe create (edited)",
			priority: 1,
		});
		expect(seen[0]?.method).toBe("PATCH");
		expect(seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn");
		expect(seen[0]?.body).toEqual({
			actor: "alice/agent1",
			patch: { title: "Probe create (edited)", priority: 1 },
		});
		expect(bead.title).toBe("Probe create (edited)");
		expect(bead.labels).toEqual(["queue:build"]);
	});

	test("claim posts the actor and reports a heartbeat", async () => {
		const first = fake(200, claimed);
		const res = await first.client.claim("pr-pkn", "alice/agent1");
		expect(first.seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn:claim");
		expect(first.seen[0]?.body).toEqual({ actor: "alice/agent1" });
		expect(res.alreadyClaimed).toBe(false);
		expect(res.bead.assignee).toBe("alice/agent1");
		expect(res.bead.lease?.expiresAt).toBe("2026-11-10T05:49:52.000Z");

		const again = fake(200, claimHeartbeat);
		const renewed = await again.client.claim("pr-x1u", "bob/agent2");
		expect(renewed.alreadyClaimed).toBe(true);
	});

	test("release, close and comment hit their routes", async () => {
		const r = fake(200, released);
		const bead = await r.client.release("pr-pkn", "alice/agent1");
		expect(r.seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn:release");
		expect(bead.status).toBe("open");
		expect(bead.assignee).toBeUndefined();
		expect(bead.lease).toBeUndefined();

		const c = fake(200, closed);
		const done = await c.client.close("pr-pkn", "alice/agent1", "done");
		expect(c.seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn:close");
		expect(c.seen[0]?.body).toEqual({ actor: "alice/agent1", reason: "done" });
		expect(done.status).toBe("closed");
		expect(done.closedAt).toBe("2026-11-10T05:44:53.000Z");

		const m = fake(200, commented);
		const note = await m.client.comment(
			"pr-pkn",
			"alice/agent1",
			"working on it",
		);
		expect(m.seen[0]?.url.pathname).toBe("/v0/beads/issues/pr-pkn/comments");
		expect(m.seen[0]?.body).toEqual({
			author: "alice/agent1",
			text: "working on it",
		});
		expect(note).toEqual({
			id: "bed5f309-cc78-5fd6-9e53-2bf06249085f",
			beadId: "pr-pkn",
			author: "alice/agent1",
			text: "working on it",
			createdAt: "2026-11-10T05:45:06.000Z",
		});
	});

	test("events passes since and maps records in order", async () => {
		const { client, seen } = fake(200, events);
		const page = await client.events(5, 100);
		expect(seen[0]?.url.pathname).toBe("/v0/beads/events");
		expect(seen[0]?.url.searchParams.get("since")).toBe("5");
		expect(seen[0]?.url.searchParams.get("limit")).toBe("100");
		expect(page.head).toBe(10);
		expect(page.events.map((e) => [e.seq, e.op])).toEqual([
			[6, "update"],
			[7, "update"],
			[8, "update"],
			[9, "update"],
			[10, "close"],
		]);
		expect(page.events[1]?.bead?.lease?.expiresAt).toBe(
			"2026-11-10T05:49:52.000Z",
		);
		expect(page.events[4]?.bead?.status).toBe("closed");
	});

	test("sends the bearer token when given", async () => {
		const { client, seen } = fake(200, ready, "s3cret");
		await client.ready();
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer s3cret");
		expect(seen[0]?.url.search).toBe("");
	});
});

describe("BdClient errors", () => {
	test("409 already_claimed is AlreadyClaimed with the holder", async () => {
		const { client } = fake(409, claim409);
		const err = await client.claim("pr-pkn", "bob/agent2").catch((e) => e);
		expect(err).toBeInstanceOf(AlreadyClaimed);
		expect(err).toBeInstanceOf(BdError);
		expect(err.assignee).toBe("alice/agent1");
		expect(err.status).toBe(409);
	});

	test("404 not_found is NotFound", async () => {
		const { client } = fake(404, get404);
		const err = await client.get("pr-nope").catch((e) => e);
		expect(err).toBeInstanceOf(NotFound);
		expect(err.message).toBe("no issue or wisp with that id");
	});

	test("other problems are BdError with bd's code", async () => {
		const r = fake(409, release409);
		const notReleasable = await r.client.release("pr-pkn", "a").catch((e) => e);
		expect(notReleasable).toBeInstanceOf(BdError);
		expect(notReleasable).not.toBeInstanceOf(AlreadyClaimed);
		expect(notReleasable.code).toBe("not_releasable");

		const b = fake(400, claim400);
		const invalid = await b.client.claim("pr-pkn", "a").catch((e) => e);
		expect(invalid.code).toBe("invalid_argument");
		expect(invalid.problem?.param).toBe("nope");
	});

	test("a non-problem body still becomes a BdError", async () => {
		const client = new BdClient({
			baseUrl: "http://bd.test",
			fetch: async () => new Response("bad gateway", { status: 502 }),
		});
		const err = await client.get("x").catch((e) => e);
		expect(err).toBeInstanceOf(BdError);
		expect(err.code).toBe("http_502");
		expect(err.message).toBe("bad gateway");
	});
});
