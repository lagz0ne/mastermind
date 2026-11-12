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
import { parseLogin } from "../src/paseo/client.ts";
import { FakePaseo, LOGGED_IN, NOT_LOGGED_IN } from "./paseo/fake.ts";

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

describe("runChecks and problems (Paseo SDK)", () => {
	const s = { ...defaultSettings("laptop"), queues: ["q"], workdir: "/w" };

	test("daemon down: every provider is false, Paseo's reason, doctor says start it", async () => {
		const fake = new FakePaseo();
		fake.down.add(undefined);
		const c = await runChecks(s, { connect: fake.connect, exists: () => true });
		expect(c).toMatchObject({
			paseo: false,
			providers: { claude: false },
			workdir: true,
		});
		const p = problems(c, s);
		expect(p).toHaveLength(1);
		expect(p[0]?.problem).toContain("ECONNREFUSED");
		expect(p[0]?.fix).toContain("paseo daemon start");
	});

	test("provider not ready (with Paseo's reason) and workdir missing", async () => {
		const fake = new FakePaseo();
		fake.providers.push({
			provider: "codex",
			status: "error",
			error: "codex not found on PATH",
		});
		const c = await runChecks(
			{ ...s, providers: ["claude", "codex"] },
			{ connect: fake.connect, exists: () => false },
		);
		expect(c.providers).toEqual({ claude: true, codex: false });
		const p = problems(c, s).map((x) => x.problem);
		expect(p).toEqual([
			"provider codex is not available in Paseo on local: error (codex not found on PATH)",
			"workdir /w does not exist",
		]);
		expect(fake.ops("diagnostic")).toEqual([]);
		expect(fake.open).toBe(0);
	});

	test("--no-box (login): a provider Paseo says is not logged in is not available, with Paseo's reason", async () => {
		const fake = new FakePaseo();
		fake.providers[0] = { provider: "claude", diagnostic: NOT_LOGGED_IN };
		const box = await runChecks(s, {
			connect: fake.connect,
			exists: () => true,
		});
		expect(box.providers).toEqual({ claude: true });
		const c = await runChecks(s, {
			connect: fake.connect,
			exists: () => true,
			login: true,
		});
		expect(c.providers).toEqual({ claude: false });
		const [p] = problems(c, s);
		expect(p?.problem).toBe(
			"provider claude is not logged in on local (Paseo: loggedIn false, authMethod none)",
		);
		expect(p?.fix).toContain("paseo provider diagnostic claude");
		fake.providers[0] = { provider: "claude", diagnostic: LOGGED_IN };
		const ok = await runChecks(s, {
			connect: fake.connect,
			exists: () => true,
			login: true,
		});
		expect(ok.providers).toEqual({ claude: true });
		expect(problems(ok, s)).toEqual([]);
	});
});

describe("parseLogin (Paseo's provider diagnostic text)", () => {
	test("reads Auth.loggedIn, authMethod and Status", () => {
		expect(parseLogin(LOGGED_IN)).toEqual({
			loggedIn: true,
			authMethod: "oauth_token",
			status: "Ready",
		});
		expect(parseLogin(NOT_LOGGED_IN).loggedIn).toBe(false);
		expect(parseLogin("Codex\n  Status: Unavailable")).toEqual({
			loggedIn: null,
			authMethod: null,
			status: "Unavailable",
		});
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
