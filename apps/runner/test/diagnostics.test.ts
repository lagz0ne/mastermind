import { describe, expect, test } from "bun:test";
import type { RunnerDiagnostics } from "@mastermind/core";
import { defaultSettings } from "../src/config.ts";
import {
	Diagnostics,
	KEEP_ERRORS,
	problems,
	redactLine,
	runChecks,
	startReporter,
} from "../src/diagnostics.ts";

describe("redactLine", () => {
	test.each([
		["credential mms_alice_0a1b2c_secret refused", "mms_…"],
		["token=abc123 x", "token=…"],
		['{"password": "hunter2"}', '"password": "…"'],
		["wss://u:pw@nats.example", "//u:…@"],
		["enrol mme_zzz", "mme_…"],
		["gh token ghp_ABCdef123", "ghp_…"],
	])("%p", (line, keep) => {
		const out = redactLine(line);
		expect(out).toContain(keep);
		for (const secret of [
			"0a1b2c_secret",
			"abc123",
			"hunter2",
			":pw@",
			"zzz",
			"ABCdef",
		])
			expect(out).not.toContain(secret);
	});
});

describe("runChecks and problems", () => {
	const s = { ...defaultSettings("laptop"), queues: ["q"], workdir: "/w" };

	test("daemon down: every provider is false, doctor says start it", async () => {
		const c = await runChecks(s, {
			paseo: async () => ({ code: 1, stdout: "" }),
			exists: () => true,
		});
		expect(c).toMatchObject({
			paseo: false,
			providers: { claude: false },
			workdir: true,
		});
		const p = problems(c, s);
		expect(p).toHaveLength(1);
		expect(p[0]?.fix).toContain("paseo daemon start");
	});

	test("provider not logged in and workdir missing", async () => {
		const c = await runChecks(
			{ ...s, providers: ["claude", "codex"] },
			{
				paseo: async (args) =>
					args[0] === "provider"
						? {
								code: 0,
								stdout: JSON.stringify([
									{ provider: "claude", status: "available" },
									{ provider: "codex", status: "unavailable" },
								]),
							}
						: { code: 0, stdout: "[]" },
				exists: () => false,
			},
		);
		expect(c.providers).toEqual({ claude: true, codex: false });
		const p = problems(c, s).map((x) => x.problem);
		expect(p).toEqual([
			"provider codex is not available in Paseo",
			"workdir /w does not exist",
		]);
	});
});

describe("Diagnostics", () => {
	test("keeps the last problem lines, redacted, and makes a snapshot", () => {
		const d = new Diagnostics(
			{ ...defaultSettings("laptop"), queues: ["q"] },
			"abc",
			() => new Date("2026-11-11T00:00:00Z"),
		);
		d.log("runner up");
		for (let i = 0; i < KEEP_ERRORS + 5; i++)
			d.log(`next q: error ${i} token=sekrit`);
		d.loop = {
			inFlight: () => [],
			lastNextAt: "t",
			lastNextResult: "error",
			lastDecision: null,
		};
		const snap = d.snapshot();
		expect(snap.lastErrors).toHaveLength(KEEP_ERRORS);
		expect(snap.lastErrors[0]).toBe("next q: error 5 token=…");
		expect(JSON.stringify(snap)).not.toContain("sekrit");
		expect(snap).toMatchObject({
			runner: "laptop",
			version: "abc",
			state: "connecting",
			lastNextResult: "error",
			at: "2026-11-11T00:00:00.000Z",
		});
	});

	test("the reporter sends at once, on change and on stop", async () => {
		const d = new Diagnostics(defaultSettings("laptop"), "dev");
		const sent: RunnerDiagnostics[] = [];
		const r = startReporter({
			diagnostics: d,
			publish: (x) => sent.push(x),
			check: async () => ({
				paseo: true,
				providers: {},
				workdir: null,
				checkedAt: "now",
			}),
			everyMs: 60_000,
			debounceMs: 5,
		});
		await Bun.sleep(20);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.checks.paseo).toBe(true);
		d.set("connected");
		await Bun.sleep(30);
		expect(sent.at(-1)?.state).toBe("connected");
		d.set("stopping");
		await r.stop();
		expect(sent.at(-1)?.state).toBe("stopping");
	});
});
