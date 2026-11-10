import { describe, expect, test } from "bun:test";
import { login, tokenFromHash } from "./login.ts";

const reply = (status: number, body: unknown) =>
	(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("tokenFromHash", () => {
	test("takes a login token from the fragment", () => {
		expect(tokenFromHash("#mml_abc")).toBe("mml_abc");
		expect(tokenFromHash("")).toBeNull();
		expect(tokenFromHash("#something")).toBeNull();
	});
});

describe("login", () => {
	test("no token: nothing to do", async () => {
		expect(await login(null, reply(200, {}))).toEqual({ kind: "no-token" });
	});

	test("ok, refused, error", async () => {
		expect(await login("mml_a", reply(200, { account: "admin" }))).toEqual({
			kind: "ok",
			account: "admin",
		});
		expect(await login("mml_a", reply(401, { error: "used" }))).toEqual({
			kind: "refused",
		});
		expect(
			await login("mml_a", reply(409, { error: "account bob exists" })),
		).toEqual({
			kind: "error",
			message: "account bob exists",
		});
	});

	test("posts the token as JSON", async () => {
		let sent: RequestInit | undefined;
		const fetcher = (async (_url: string, init: RequestInit) => {
			sent = init;
			return Response.json({ account: "admin" });
		}) as unknown as typeof fetch;
		await login("mml_a", fetcher);
		expect(sent?.method).toBe("POST");
		expect(JSON.parse(String(sent?.body))).toEqual({ token: "mml_a" });
	});
});
