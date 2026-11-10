import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { health } from "./app.ts";

const failing = (() =>
	Promise.reject(new Error("connection refused"))) as unknown as SQL;
const working = (() => Promise.resolve([{ "?column?": 1 }])) as unknown as SQL;

test("health without a database is ok and reports the version", async () => {
	const res = await health(null, "abc123");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		ok: true,
		version: "abc123",
		db: "unconfigured",
	});
});

test("health with a reachable database reports up", async () => {
	const res = await health(working, "abc123");
	expect(await res.json()).toMatchObject({ ok: true, db: "up" });
});

test("health with an unreachable database is 503", async () => {
	const res = await health(failing, "abc123");
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, db: "down" });
});
