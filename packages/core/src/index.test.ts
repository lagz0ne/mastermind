import { expect, test } from "bun:test";
import { isHealthy } from "./index.ts";

test("only a down dependency makes the service unhealthy", () => {
	expect(isHealthy("up")).toBe(true);
	expect(isHealthy("unconfigured")).toBe(true);
	expect(isHealthy("down")).toBe(false);
});

test("every probe counts", () => {
	expect(isHealthy("up", "unconfigured", "up")).toBe(true);
	expect(isHealthy("up", "up", "down")).toBe(false);
	expect(isHealthy()).toBe(true);
});
