import { expect, test } from "bun:test";
import {
	addEnvironment,
	changes,
	erroredIndexes,
	errorsFor,
	fromForm,
	removeEnvironment,
	toForm,
} from "./environments.ts";

const scratch = {
	name: "scratch",
	description: "throwaway",
	repo: "https://github.com/acme/scratch.git",
	ref: "main",
	requires: ["bun>=1.4"],
	setup: ["bun install", "bun run build"],
	check: ["bun test"],
	secrets: ["GH_TOKEN"],
	agent: { provider: "claude" },
	instructions: "Small commits.",
};

test("a form round-trips an environment; lists split by line or word", () => {
	expect(fromForm(toForm(scratch))).toEqual(scratch);
	const f = {
		...toForm(scratch),
		requires: "a, b a",
		setup: " x \n\n y ",
		mode: "",
	};
	expect(fromForm(f).requires).toEqual(["a", "b"]);
	expect(fromForm(f).setup).toEqual(["x", "y"]);
	expect(fromForm({ ...f, provider: "", instructions: " " })).not.toContainKeys(
		["agent", "instructions"],
	);
});

test("add picks a free name; changes counts environments", () => {
	const one = addEnvironment({ environments: [] });
	expect(one.doc.environments[0]?.name).toBe("new");
	const two = addEnvironment(one.doc);
	expect(two.doc.environments[1]?.name).toBe("new-2");
	expect(two.index).toBe(1);
	expect(changes(one.doc, two.doc)).toBe(1);
	expect(changes(two.doc, removeEnvironment(two.doc, 0))).toBe(2);
});

test("server errors map to form fields of one environment", () => {
	const errors = [
		{ field: "environments.1.repo", message: "required" },
		{ field: "environments.1.setup.0", message: "must be non-empty text" },
		{ field: "environments.1.agent.mode", message: "one word, no spaces" },
		{ field: "environments.0.name", message: "used twice" },
	];
	expect(errorsFor(errors, 1)).toEqual({
		repo: "required",
		setup: "must be non-empty text (1)",
		mode: "one word, no spaces",
	});
	expect([...erroredIndexes(errors)].sort()).toEqual([0, 1]);
});
