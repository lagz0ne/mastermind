import { describe, expect, test } from "bun:test";
import {
	clock,
	pollCode,
	resumeOrStart,
	secondsLeft,
	startCode,
} from "./login.ts";

const reply = (status: number, body: unknown) =>
	(async () => Response.json(body, { status })) as unknown as typeof fetch;

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

	test("poll gives the pending code back", async () => {
		expect(
			await pollCode(
				reply(200, {
					status: "pending",
					code: "ABCD-EFGH",
					expiresAt: "2026-11-10T10:10:00Z",
				}),
			),
		).toEqual({
			kind: "pending",
			code: "ABCD-EFGH",
			expiresAt: "2026-11-10T10:10:00Z",
		});
	});

	test("resume after a reload: same code, no new start", async () => {
		const calls: string[] = [];
		const fetcher = (async (url: string) => {
			calls.push(url);
			return url.endsWith("/poll")
				? Response.json({
						status: "pending",
						code: "ABCD-EFGH",
						expiresAt: "2026-11-10T10:10:00Z",
					})
				: Response.json({ code: "WXYZ-2345", expiresAt: "x" }, { status: 201 });
		}) as unknown as typeof fetch;
		expect(await resumeOrStart(fetcher)).toEqual({
			kind: "code",
			code: "ABCD-EFGH",
			expiresAt: "2026-11-10T10:10:00Z",
		});
		expect(calls).toEqual(["/api/auth/login/poll"]);
	});

	test("resume: approved while away logs in; none pending starts a code", async () => {
		expect(
			await resumeOrStart(reply(200, { status: "approved", account: "duke" })),
		).toEqual({ kind: "ok", account: "duke" });
		const calls: string[] = [];
		const fetcher = (async (url: string) => {
			calls.push(url);
			return url.endsWith("/poll")
				? Response.json({ status: "expired" })
				: Response.json(
						{ code: "WXYZ-2345", expiresAt: "2026-11-10T10:10:00Z" },
						{ status: 201 },
					);
		}) as unknown as typeof fetch;
		expect(await resumeOrStart(fetcher)).toEqual({
			kind: "code",
			code: "WXYZ-2345",
			expiresAt: "2026-11-10T10:10:00Z",
		});
		expect(calls).toEqual(["/api/auth/login/poll", "/api/auth/login/start"]);
	});

	test("countdown", () => {
		const now = Date.parse("2026-11-10T10:00:00Z");
		expect(secondsLeft("2026-11-10T10:02:05Z", now)).toBe(125);
		expect(secondsLeft("2026-11-10T09:00:00Z", now)).toBe(0);
		expect(clock(125)).toBe("2:05");
		expect(clock(0)).toBe("0:00");
	});
});
