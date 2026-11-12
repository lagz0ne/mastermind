import { expect, test } from "bun:test";
import { runnerVersionNotice, shortVersion } from "./runner-version.ts";

test("one notice when the runner is not at the server's commit", () => {
	expect(
		runnerVersionNotice(
			"2f22252aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"ce20fc6bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		),
	).toBe(
		"runner 2f22252 is older than the server ce20fc6: run mastermind-runner update",
	);
});

test("no notice: same version, unknown, or run from source", () => {
	expect(runnerVersionNotice("abc1234", "abc1234")).toBeNull();
	expect(runnerVersionNotice(undefined, "abc1234")).toBeNull();
	expect(runnerVersionNotice("abc1234", null)).toBeNull();
	expect(runnerVersionNotice("dev", "abc1234")).toBeNull();
	expect(runnerVersionNotice("abc1234", "dev")).toBeNull();
});

test("shortVersion shortens commits only", () => {
	expect(shortVersion("ce20fc6bbbbbbbbb")).toBe("ce20fc6");
	expect(shortVersion("v1.2.3")).toBe("v1.2.3");
});
