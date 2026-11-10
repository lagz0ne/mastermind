import { expect, test } from "bun:test";
import { envLabel, envNameOf } from "./dispatch.ts";

test("envNameOf reads the env: label and ignores an empty one", () => {
	expect(envNameOf({ labels: ["queue:a", envLabel("scratch")] })).toBe(
		"scratch",
	);
	expect(envNameOf({ labels: ["env:"] })).toBeNull();
	expect(envNameOf({ labels: [] })).toBeNull();
});
