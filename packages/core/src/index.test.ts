import { expect, test } from "bun:test";
import { isHealthy } from "./index.ts";

test("only a down database makes the service unhealthy", () => {
	expect(isHealthy("up")).toBe(true);
	expect(isHealthy("unconfigured")).toBe(true);
	expect(isHealthy("down")).toBe(false);
});
