import { afterAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { health, noDeps } from "./app.ts";

const failing = (() =>
	Promise.reject(new Error("connection refused"))) as unknown as SQL;
const working = (() => Promise.resolve([{ "?column?": 1 }])) as unknown as SQL;

const bdReady = Bun.serve({
	port: 0,
	fetch: (req) =>
		new URL(req.url).pathname === "/v0/beads/ready"
			? Response.json([])
			: new Response("not found", { status: 404 }),
});
afterAll(() => bdReady.stop(true));

test("health without dependencies is ok and reports the version", async () => {
	const res = await health(noDeps, "abc123");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		ok: true,
		version: "abc123",
		db: "unconfigured",
		dolt: "unconfigured",
		bd: "unconfigured",
	});
});

test("health with reachable dependencies reports them up", async () => {
	const res = await health(
		{ db: working, dolt: working, bdUrl: bdReady.url.origin },
		"abc123",
	);
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		ok: true,
		db: "up",
		dolt: "up",
		bd: "up",
	});
});

test("health with an unreachable database is 503", async () => {
	const res = await health({ ...noDeps, db: failing }, "abc123");
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, db: "down" });
});

test("health with dolt down is 503", async () => {
	const res = await health({ ...noDeps, dolt: failing }, "abc123");
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, dolt: "down" });
});

test("health with bd serve not listening is 503", async () => {
	const res = await health(
		{ ...noDeps, bdUrl: "http://127.0.0.1:1" },
		"abc123",
	);
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, bd: "down" });
});
