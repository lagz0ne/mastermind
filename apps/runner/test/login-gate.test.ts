/**
 * mm-210.81 gap: a failed doctor --deep box probe sets the login gate (a file
 * next to runner.json, so another process and a restart see it); a passing
 * probe lifts it. Name and hash only, never the value.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorReport, DoctorStep } from "../src/doctor.ts";
import {
	gatePath,
	probeOutcome,
	readGate,
	recordProbe,
} from "../src/login-gate.ts";
import { secretHash } from "../src/readiness.ts";

const SECRETS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const model = { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-wrong" };
const LOGIN =
	'provider login failed: the agent\'s provider answered "Failed to authenticate" (paseo: the agent answered with no result: Failed to authenticate. API Error: 401 OAuth access token is invalid.)';

const report = (
	e: Partial<DoctorStep> | null,
	o: { deep?: boolean; at?: string } = {},
): DoctorReport => ({
	runner: "yo-buid",
	at: o.at ?? "2026-11-12T16:19:00.000Z",
	deep: o.deep ?? true,
	ok: e?.status !== "fail",
	steps: e
		? [{ id: "e", name: "agent", status: "pass", ms: 1, detail: [], ...e }]
		: [],
});
const config = () =>
	join(mkdtempSync(join(tmpdir(), "mm-gate-")), "runner.json");

describe("box probe outcome", () => {
	test("step e failed with the provider's 401: refused, for the secret the probe used", () => {
		const o = probeOutcome(
			report({ status: "fail", problem: LOGIN }),
			model,
			SECRETS,
		);
		expect(o).toEqual({
			refused: {
				secret: "CLAUDE_CODE_OAUTH_TOKEN",
				hash: secretHash(model.value),
				at: "2026-11-12T16:19:00.000Z",
				problem: "Failed to authenticate",
			},
		});
		expect(JSON.stringify(o)).not.toContain(model.value);
	});

	test("pass: passed; another failure, no deep run or no model credential: nothing", () => {
		expect(probeOutcome(report({ status: "pass" }), model, SECRETS)).toEqual({
			passed: true,
		});
		expect(
			probeOutcome(
				report({ status: "fail", problem: "no answer within 120 s" }),
				model,
				SECRETS,
			),
		).toBeNull();
		expect(
			probeOutcome(
				report({ status: "fail", problem: LOGIN }, { deep: false }),
				model,
				SECRETS,
			),
		).toBeNull();
		expect(
			probeOutcome(report({ status: "fail", problem: LOGIN }), null, SECRETS),
		).toBeNull();
	});
});

describe("login-gate.json", () => {
	test("a failed probe writes the refusal (0600, no value); a later passing probe clears it; an older one does not", async () => {
		const path = config();
		// A fixed clock: each write gets the next minute (no real time in the test).
		let minute = 0;
		const clock = () => new Date(Date.UTC(2026, 10, 12, 17, minute++, 0));
		expect(await readGate(path)).toBeNull();
		const set = await recordProbe(
			path,
			report({ status: "fail", problem: LOGIN }),
			model,
			SECRETS,
			clock,
		);
		expect(set).toEqual({
			refused: {
				secret: "CLAUDE_CODE_OAUTH_TOKEN",
				hash: secretHash(model.value),
				at: "2026-11-12T16:19:00.000Z",
				problem: "Failed to authenticate",
			},
			at: "2026-11-12T17:00:00.000Z",
		});
		expect(await readGate(path)).toEqual(set);
		expect(statSync(gatePath(path)).mode & 0o777).toBe(0o600);
		expect(await Bun.file(gatePath(path)).text()).not.toContain(model.value);
		// A pass from before the refusal changes nothing.
		expect(
			await recordProbe(
				path,
				report({ status: "pass" }, { at: "2026-11-12T16:00:00.000Z" }),
				model,
				SECRETS,
				clock,
			),
		).toBeNull();
		expect(await readGate(path)).toEqual(set);
		const cleared = await recordProbe(
			path,
			report({ status: "pass" }, { at: "2026-11-12T16:30:00.000Z" }),
			model,
			SECRETS,
			clock,
		);
		// The rejected older pass took 17:01 from the clock.
		expect(cleared).toEqual({ refused: null, at: "2026-11-12T17:02:00.000Z" });
		expect(await readGate(path)).toEqual(cleared);
	});

	test("a pass with no refusal writes nothing", async () => {
		const path = config();
		expect(
			await recordProbe(path, report({ status: "pass" }), model, SECRETS),
		).toBeNull();
		expect(await Bun.file(gatePath(path)).exists()).toBe(false);
	});
});
