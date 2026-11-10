import { describe, expect, test } from "bun:test";
import {
	clock,
	login,
	pollCode,
	secondsLeft,
	startCode,
	tokenFromHash,
} from "./login.ts";

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

describe("login by code", () => {
	test("start", async () => {
		expect(
			await startCode(
				reply(201, { code: "ABCD-EFGH", expiresAt: "2026-11-10T10:10:00Z" }),
			),
		).toEqual({
			kind: "code",
			code: "ABCD-EFGH",
			expiresAt: "2026-11-10T10:10:00Z",
		});
		expect(await startCode(reply(429, { error: "too many" }))).toEqual({
			kind: "error",
			message: "too many",
		});
	});

	test("poll", async () => {
		expect(await pollCode(reply(200, { status: "pending" }))).toEqual({
			kind: "pending",
		});
		expect(
			await pollCode(reply(200, { status: "approved", account: "duke" })),
		).toEqual({ kind: "ok", account: "duke" });
		expect(await pollCode(reply(200, { status: "expired" }))).toEqual({
			kind: "expired",
		});
		expect(await pollCode(reply(503, { error: "auth is starting" }))).toEqual({
			kind: "error",
			message: "auth is starting",
		});
	});

	test("countdown", () => {
		const now = Date.parse("2026-11-10T10:00:00Z");
		expect(secondsLeft("2026-11-10T10:02:05Z", now)).toBe(125);
		expect(secondsLeft("2026-11-10T09:00:00Z", now)).toBe(0);
		expect(clock(125)).toBe("2:05");
		expect(clock(0)).toBe("0:00");
	});
});
