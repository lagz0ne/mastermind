import { describe, expect, test } from "bun:test";
import { newestFirstLogin } from "./first-login.ts";

const url = (n: number) => `https://mm.example/login#mml_tok${n}`;

describe("newestFirstLogin", () => {
	test("no line", () => {
		expect(newestFirstLogin("auth: ready\nlistening on :3000\n")).toEqual({
			kind: "none",
		});
	});

	test("the newest URL wins (each start rotates the token)", () => {
		const log = [
			`2026-11-10T08:00:00.000000000Z auth: first login (single use): ${url(1)}`,
			"2026-11-10T08:00:01.000000000Z auth: ready",
			`2026-11-10T09:00:00.000000000Z auth: first login (single use): ${url(2)}`,
		].join("\n");
		expect(newestFirstLogin(log)).toEqual({
			kind: "url",
			url: url(2),
			at: "2026-11-10T09:00:00.000000000Z",
		});
	});

	test("service logs of many tasks are sorted by time", () => {
		const log = [
			`mastermind.1.new@node | 2026-11-10T09:00:00.000Z auth: first login (single use): ${url(2)}`,
			`mastermind.1.old@node | 2026-11-10T08:00:00.000Z auth: first login (single use): ${url(1)}`,
		].join("\n");
		expect(newestFirstLogin(log)).toMatchObject({ kind: "url", url: url(2) });
	});

	test("an account exists after the last URL", () => {
		const log = [
			`2026-11-10T08:00:00Z auth: first login (single use): ${url(1)}`,
			"2026-11-10T09:00:00Z auth: first login: not needed, an account exists",
		].join("\n");
		expect(newestFirstLogin(log)).toEqual({
			kind: "not-needed",
			at: "2026-11-10T09:00:00Z",
		});
	});

	test("lines without timestamps keep their order", () => {
		const log = `auth: first login (single use): ${url(1)}\nauth: first login (single use): ${url(2)}`;
		expect(newestFirstLogin(log)).toMatchObject({ url: url(2), at: null });
	});
});
