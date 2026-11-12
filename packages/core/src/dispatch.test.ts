import { expect, test } from "bun:test";
import {
	envLabel,
	envNameOf,
	isAddress,
	parseAddress,
	toLabel,
	toOf,
} from "./dispatch.ts";

test("envNameOf reads the env: label and ignores an empty one", () => {
	expect(envNameOf({ labels: ["queue:a", envLabel("scratch")] })).toBe(
		"scratch",
	);
	expect(envNameOf({ labels: ["env:"] })).toBeNull();
	expect(envNameOf({ labels: [] })).toBeNull();
});

test("parseAddress: an account, or an account and one runner", () => {
	expect(parseAddress("bob")).toEqual({ account: "bob" });
	expect(parseAddress("bob/laptop")).toEqual({
		account: "bob",
		runner: "laptop",
	});
	for (const bad of [
		"",
		"Bob",
		"bob/",
		"/laptop",
		"bob/a/b",
		"bob/a.b",
		"bob/a b",
	])
		expect(parseAddress(bad)).toBeNull();
	expect(isAddress("bob/laptop")).toBe(true);
	expect(isAddress(3)).toBe(false);
});

test("toOf reads the to: label and ignores an empty one", () => {
	expect(toOf({ labels: ["x", toLabel("bob/laptop")] })).toBe("bob/laptop");
	expect(toOf({ labels: ["to:"] })).toBeNull();
	expect(toOf({ labels: [] })).toBeNull();
});
