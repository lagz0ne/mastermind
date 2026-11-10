import { describe, expect, test } from "bun:test";
import { BusError, decode, encode, errorReply, unwrap } from "./codec.ts";

describe("codec", () => {
	test("JSON round-trip; empty payload is undefined", () => {
		expect(decode(encode({ a: 1, b: ["x"] }))).toEqual({ a: 1, b: ["x"] });
		expect(decode(new Uint8Array())).toBeUndefined();
	});

	test("non-JSON payload is a bad_request", () => {
		const err = (() => {
			try {
				decode(new TextEncoder().encode("{nope"));
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(BusError);
		expect((err as BusError).code).toBe("bad_request");
	});

	test("unwrap returns the result or throws the carried error", () => {
		expect(unwrap({ result: { ok: true } })).toEqual({ ok: true });
		expect(unwrap({ result: null })).toBeNull();
		expect(() =>
			unwrap({ error: { code: "conflict", message: "taken" } }),
		).toThrow(expect.objectContaining({ code: "conflict", message: "taken" }));
	});

	test("unwrap treats unknown codes and shapes as internal", () => {
		expect(() => unwrap({ error: { code: "weird", message: "m" } })).toThrow(
			expect.objectContaining({ code: "internal", message: "m" }),
		);
		for (const bad of [null, 1, "x", {}, { error: null }]) {
			expect(() => unwrap(bad)).toThrow(BusError);
		}
	});

	test("errorReply keeps BusErrors and hides other messages", () => {
		expect(errorReply(new BusError("not_found", "no bead mm-1"))).toEqual({
			error: { code: "not_found", message: "no bead mm-1" },
		});
		expect(errorReply(new Error("db password is hunter2"))).toEqual({
			error: { code: "internal", message: "internal error" },
		});
	});
});
