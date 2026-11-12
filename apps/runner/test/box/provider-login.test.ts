import { describe, expect, test } from "bun:test";
import { type BoxTask, runInBox } from "../../src/box/run.ts";
import { LaunchError, PROVIDER_LOGIN_FIX } from "../../src/launcher.ts";
import { FakeDriver } from "./fake-driver.ts";

// mm-210.72: a box with no provider credential. Paseo reports the agent as
// idle/finished with 0 tokens; `paseo run --output-schema` exits 1 with this
// (real paseo 0.15.4 output, claude with no credential).
const NO_LOGIN = JSON.stringify({
	error: {
		code: "OUTPUT_SCHEMA_FAILED",
		message: "Agent response did not match the required output schema",
		details:
			"Invalid JSON: Unexpected token 'N', \"Not logged\"... is not valid JSON",
	},
});

const task: BoxTask = {
	executionId: "mm-1-login",
	beadId: "mm-1",
	runnerId: "laptop",
	title: "mm-1: fix it",
	prompt: "fix the bug",
	env: {
		name: "web",
		repo: "https://github.com/acme/web.git",
		ref: "main",
		requires: [],
		image: "",
		tools: [],
		recipeHash: "h1",
		setup: [],
		check: [],
		limits: { cpu: 2, memoryMb: 2048, timeoutMin: 60 },
		network: "open",
	},
	agent: { provider: "claude" },
	secrets: {},
};

describe("runInBox: provider login (mm-210.72)", () => {
	test("an agent that cannot log in fails the task with the reason and the fix, not done; the box is deleted", async () => {
		const d = new FakeDriver();
		d.handler = (cmd) =>
			cmd[0] === "paseo" && cmd[1] === "run"
				? { code: 1, stdout: NO_LOGIN, stderr: "" }
				: undefined;
		const err = await runInBox(
			task,
			{
				driver: d,
				defaultImage: "ghcr.io/getpaseo/paseo:0.15.4",
				readyCommand: null,
			},
			new AbortController().signal,
		).then(
			() => null,
			(e: Error) => e,
		);
		expect(err).toBeInstanceOf(LaunchError);
		expect(err?.message).toStartWith("provider login failed: ");
		expect(err?.message).toContain(`fix: ${PROVIDER_LOGIN_FIX}`);
		expect(d.boxes.size).toBe(0);
		expect(d.removed).toHaveLength(1);
	});
});
