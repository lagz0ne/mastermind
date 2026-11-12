import { expect, test } from "bun:test";
import type { Environment } from "@mastermind/core";
import {
	addEnvironment,
	changes,
	erroredIndexes,
	errorsFor,
	formErrors,
	fromForm,
	removeEnvironment,
	toForm,
} from "./environments.ts";

const box: Environment = {
	name: "box",
	description: "every field",
	image: "ghcr.io/acme/box:1",
	tools: ["RUN apt-get install -y jq"],
	setup: ["bun install", "bun run build"],
	check: ["bun test"],
	limits: { cpu: 1.5, memoryMb: 2048, timeoutMin: 30 },
	network: { allow: ["github.com", "*.npmjs.org"] },
	repo: "https://github.com/acme/box.git",
	ref: "dev",
	requires: ["docker"],
	secrets: ["GH_TOKEN"],
	provider: { name: "claude", auth: "CLAUDE_TOKEN" },
	agent: { mode: "bypass" },
	output: { kind: "pr", base: "main" },
	instructions: "Small commits.",
};

test("a form round-trips a full recipe; lists split by line or word", () => {
	expect(fromForm(toForm(box))).toEqual(box);
	const f = {
		...toForm(box),
		requires: "a, b a",
		setup: " x \n\n y ",
		network: "open",
		mode: "",
		outputBase: "",
	};
	const e = fromForm(f);
	expect(e.requires).toEqual(["a", "b"]);
	expect(e.setup).toEqual(["x", "y"]);
	expect(e.network).toBe("open");
	expect(e.output).toEqual({ kind: "pr" });
	expect(fromForm({ ...f, network: "" }).network).toBe("open");
	expect(fromForm({ ...f, provider: "", instructions: " " })).not.toContainKeys(
		["agent", "provider", "instructions"],
	);
});

test("empty limits take the defaults; a word is flagged before save", () => {
	const f = { ...toForm(box), cpu: "", memoryMb: "", timeoutMin: "" };
	expect(fromForm(f).limits).toEqual({
		cpu: 2,
		memoryMb: 4096,
		timeoutMin: 60,
	});
	expect(formErrors({ ...f, cpu: "two" })).toEqual({ cpu: "a number" });
	expect(formErrors(toForm(box))).toEqual({});
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
		{ field: "environments.1.limits.memoryMb", message: "a whole number" },
		{ field: "environments.1.network.allow.2", message: "a host" },
		{ field: "environments.1.provider.auth", message: "a secret name" },
		{ field: "environments.1.output.kind", message: "pr, branch or none" },
		{ field: "environments.0.name", message: "used twice" },
	];
	expect(errorsFor(errors, 1)).toEqual({
		repo: "required",
		setup: "must be non-empty text (1)",
		mode: "one word, no spaces",
		memoryMb: "a whole number",
		network: "a host (3)",
		providerAuth: "a secret name",
		outputKind: "pr, branch or none",
	});
	expect([...erroredIndexes(errors)].sort()).toEqual([0, 1]);
});

test("dev container settings round-trip; errors map to their fields (mm-210.62)", () => {
	const dc: Environment = {
		...box,
		devcontainer: {
			use: "none",
			configPath: "python",
			config: '{"image": "debian"}',
			allowHost: ["initializeCommand"],
		},
	};
	expect(fromForm(toForm(dc))).toEqual(dc);
	const f = toForm(box);
	expect(f).toMatchObject({
		dcUse: "auto",
		dcConfigPath: "",
		dcConfig: "",
		dcAllowInit: false,
	});
	expect(fromForm(f)).not.toContainKey("devcontainer");
	expect(
		errorsFor(
			[
				{ field: "environments.0.devcontainer.config", message: "bad json" },
				{ field: "environments.0.devcontainer.configPath", message: "no .." },
				{ field: "environments.0.devcontainer.use", message: "auto or none" },
				{ field: "environments.0.devcontainer.allowHost.0", message: "one of" },
			],
			0,
		),
	).toEqual({
		dcConfig: "bad json",
		dcConfigPath: "no ..",
		dcUse: "auto or none",
		dcAllowInit: "one of",
	});
});
