import { describe, expect, test } from "bun:test";
import {
	envLabel,
	envNameOf,
	isAddress,
	notReadyReasons,
	otherProcess,
	parseAddress,
	READINESS_FRESH_MS,
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

describe("notReadyReasons (mm-210.59)", () => {
	const ready = {
		readiness: {
			state: "ready" as const,
			readyEnvironments: ["web"],
			failedChecks: [
				{
					check: "secrets",
					environment: "api",
					problem: "missing secrets: TOKEN",
				},
			],
			checkedAt: "2026-11-12T00:00:00Z",
		},
	};
	test("no status, stale status, no readiness: refused", () => {
		expect(notReadyReasons(null, null, 1000)[0]).toContain("no status");
		expect(
			notReadyReasons(ready, 0, READINESS_FRESH_MS + 1, "web")[0],
		).toContain("old");
		expect(notReadyReasons({}, 0, 0)[0]).toContain("does not report");
	});
	test("ready: items without environment and ready environments pass", () => {
		expect(notReadyReasons(ready, 0, 1000)).toEqual([]);
		expect(notReadyReasons(ready, 0, 1000, "web")).toEqual([]);
		expect(notReadyReasons(ready, 0, 1000, "api")).toEqual([
			"environment api is not ready on it: missing secrets: TOKEN",
		]);
	});
	test("not ready: the runner-wide failed checks are the reason", () => {
		const degraded = {
			readiness: {
				...ready.readiness,
				state: "degraded" as const,
				readyEnvironments: [],
				failedChecks: [{ check: "engine", problem: "Docker does not answer" }],
			},
		};
		expect(notReadyReasons(degraded, 0, 1000)).toEqual([
			"state degraded: Docker does not answer",
		]);
	});
});

describe("otherProcess (mm-210.79)", () => {
	test("sessions must match; an older runner matches by version", () => {
		expect(otherProcess({ session: "a" }, { session: "a" })).toBeNull();
		expect(otherProcess({ session: "a" }, { session: "b" })).toContain(
			"another process of this runner (session a; this request: session b)",
		);
		expect(otherProcess({}, { session: "b" })).not.toBeNull();
		expect(otherProcess({ session: "a" }, { version: "v1" })).not.toBeNull();
		expect(otherProcess({ version: "v2" }, { version: "v1" })).toContain(
			"(version v2; this request: version v1)",
		);
		expect(otherProcess({ version: "v1" }, { version: "v1" })).toBeNull();
		// Cannot tell: no version on one side.
		expect(otherProcess({}, { version: "v1" })).toBeNull();
		expect(otherProcess({ version: "v1" }, {})).toBeNull();
	});

	test("notReadyReasons: a ready status of another process is not ready", () => {
		const ready = {
			version: "new",
			readiness: {
				state: "ready" as const,
				readyEnvironments: [],
				failedChecks: [],
				checkedAt: null,
			},
		};
		expect(notReadyReasons(ready, 0, 1, null, { version: "old" })[0]).toContain(
			"another process",
		);
		expect(notReadyReasons(ready, 0, 1, null, { version: "new" })).toEqual([]);
		expect(notReadyReasons(ready, 0, 1)).toEqual([]);
	});
});
