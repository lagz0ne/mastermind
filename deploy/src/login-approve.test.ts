import { describe, expect, test } from "bun:test";
import {
	approveError,
	describeApproval,
	parseApproveArgs,
} from "./login-approve.ts";

describe("parseApproveArgs", () => {
	test("code and account, in any order, code in one or two words", () => {
		expect(parseApproveArgs(["ABCD-EFGH", "--account", "duke"])).toEqual({
			code: "ABCD-EFGH",
			account: "duke",
		});
		expect(parseApproveArgs(["--account=duke", "abcd", "efgh"])).toEqual({
			code: "abcdefgh",
			account: "duke",
		});
	});

	test("a name in any case is kept as typed (trimmed); the app lowers it", () => {
		expect(parseApproveArgs(["ABCD-EFGH", "--account", " Lagz0ne "])).toEqual({
			code: "ABCD-EFGH",
			account: "Lagz0ne",
		});
	});

	test("a name that breaks the id rule is refused with the rule", () => {
		for (const bad of ["Bad Name", "-x", "a_b", "x".repeat(33)])
			expect(() => parseApproveArgs(["ABCD-EFGH", "--account", bad])).toThrow(
				"account id: a-z, 0-9 and -, at most 32",
			);
	});

	test("missing parts", () => {
		expect(parseApproveArgs(["ABCD-EFGH"])).toBeNull();
		expect(parseApproveArgs(["--account", "duke"])).toBeNull();
		expect(parseApproveArgs([])).toBeNull();
	});
});

test("messages", () => {
	expect(
		describeApproval({
			account: "duke",
			created: true,
			ageSeconds: 12,
			userAgent: "Firefox",
		}),
	).toContain("'duke' (new account)");
	expect(approveError(404, "no such code")).toContain("wrong, used or expired");
	expect(approveError(500, "boom")).toBe("HTTP 500: boom");
	expect(approveError(400, "account id: a-z, 0-9 and -, at most 32")).toBe(
		"account id: a-z, 0-9 and -, at most 32",
	);
});
