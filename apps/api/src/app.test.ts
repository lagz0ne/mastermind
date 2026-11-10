import { expect, test } from "bun:test";
import { health, noDeps } from "./app.ts";

test("health without dependencies is ok and reports the version", async () => {
	const res = await health(noDeps, "abc123");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		ok: true,
		version: "abc123",
		nats: "unconfigured",
		work: "unconfigured",
	});
});

test("health with reachable dependencies reports them up", async () => {
	const res = await health(
		{ nats: async () => "up", work: async () => "up" },
		"abc123",
	);
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		ok: true,
		version: "abc123",
		nats: "up",
		work: "up",
	});
});

test("health with the dispatcher's NATS down is 503", async () => {
	const res = await health(
		{ ...noDeps, nats: () => Promise.reject(new Error("closed")) },
		"abc123",
	);
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, nats: "down" });
});

test("health with the work store down is 503", async () => {
	const res = await health({ ...noDeps, work: async () => "down" }, "abc123");
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ ok: false, work: "down" });
});
