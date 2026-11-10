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
});
