import { expect, test } from "bun:test";
import { greet } from "./index.ts";

test("greet", () => {
	expect(greet("world")).toBe("Hello, world!");
});

test("greet handles empty name", () => {
	expect(greet("")).toBe("Hello, !");
});
