// Direct offers (mm-210.32): the runner accepts or declines with the same
// capacity and routing decision as for `next`, and runs what Mastermind sends back.
import { afterEach, describe, expect, test } from "bun:test";
import type {
	DirectOffer,
	OfferAnswer,
	OfferResult,
	RunnerInfo,
} from "@mastermind/core";
import type { CheckResult } from "../src/check.ts";
import { defaultSettings, type RunnerSettings } from "../src/config.ts";
import { answerOffer } from "../src/offer.ts";
import { parseRouting } from "../src/routing.ts";
import { Runner } from "../src/runner.ts";
import { dispatch, FakeLauncher, FakeMastermind, until } from "./fakes.ts";

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
	...defaultSettings("laptop"),
	queues: ["q"],
	workdir: "/tmp",
	agent: { provider: "claude" },
	...over,
});
const pass = async (): Promise<CheckResult> => ({
	ok: true,
	cwd: "/work",
	env: {},
});
const info: RunnerInfo = {
	id: "laptop",
	account: "alice",
	serviceAccount: "sa",
	capabilities: [],
};

function offerOf(id: string, over: Partial<DirectOffer> = {}): DirectOffer {
	const {
		actor: _a,
		lease: _l,
		...d
	} = dispatch(id, {
		queue: "to:alice/laptop",
	});
	return { ...d, address: "alice/laptop", ...over };
}

let runner: Runner | undefined;
afterEach(async () => {
	await runner?.stop();
	runner = undefined;
});

function make(
	mm: FakeMastermind,
	launcher: FakeLauncher,
	over: Partial<RunnerSettings> = {},
	routing?: ReturnType<typeof parseRouting>,
) {
	runner = new Runner({
		client: mm,
		launcher,
		settings: settings(over),
		check: pass,
		...(routing ? { routing } : {}),
		idleMs: 10,
		heartbeatMs: 20,
		backoff: { minMs: 5, maxMs: 20 },
	});
	runner.start();
	return runner;
}

/** Answer like Mastermind: accept -> the dispatch for this runner. */
const mastermind =
	(answers: OfferAnswer[], result?: OfferResult) =>
	async (a: OfferAnswer): Promise<OfferResult> => {
		answers.push(a);
		if (!a.accept) return { dispatch: null };
		return (
			result ?? { dispatch: dispatch("mm-1", { queue: "to:alice/laptop" }) }
		);
	};

describe("direct offers", () => {
	test("idle runner with capacity 1 accepts (the poller's slot does not count) and runs the dispatch", async () => {
		const mm = new FakeMastermind();
		mm.waitMs = 200; // a long poll holds the only slot
		const launcher = new FakeLauncher({ status: "done", summary: "ok" });
		const r = make(mm, launcher, { capacity: 1 });
		await until(() => mm.nextCalls > 0);
		const answers: OfferAnswer[] = [];
		await answerOffer(mastermind(answers), offerOf("mm-1"), {
			runner: info,
			taker: r,
		});
		expect(answers).toEqual([{ accept: true, runner: info }]);
		await until(() => mm.verbs("complete").length === 1);
		expect(launcher.specs[0]?.beadId).toBe("mm-1");
		// Capacity is still 1: the borrowed slot was paid back, polling goes on.
		const before = mm.nextCalls;
		await until(() => mm.nextCalls > before + 1);
	});

	test("busy at capacity: declines with the reason", async () => {
		const mm = new FakeMastermind();
		mm.push(dispatch("mm-9"));
		const launcher = new FakeLauncher();
		const r = make(mm, launcher, { capacity: 1 });
		await until(() => launcher.specs.length === 1);
		const answers: OfferAnswer[] = [];
		await answerOffer(mastermind(answers), offerOf("mm-1"), {
			runner: info,
			taker: r,
		});
		expect(answers).toEqual([
			{ accept: false, reason: "at capacity (1 of 1 busy)" },
		]);
		expect(r.lastDecision).toBe(
			"mm-1: offer declined: at capacity (1 of 1 busy)",
		);
		launcher.finish("mm-9", { status: "done", summary: "" });
	});

	test("the runner's routing declines: the reason goes back", async () => {
		const mm = new FakeMastermind();
		const routing = parseRouting({
			targets: { t: {} },
			rules: [{ match: { queue: "q" }, target: "t" }],
		});
		const r = make(mm, new FakeLauncher(), {}, routing);
		const answers: OfferAnswer[] = [];
		await answerOffer(mastermind(answers), offerOf("mm-1"), {
			runner: info,
			taker: r,
		});
		expect(answers[0]?.accept).toBe(false);
		expect((answers[0] as { reason: string }).reason).toContain(
			"to:alice/laptop",
		);
	});

	test("accepted but no dispatch came back: the slot is free again", async () => {
		const mm = new FakeMastermind();
		mm.waitMs = 50;
		const launcher = new FakeLauncher({ status: "done", summary: "ok" });
		const r = make(mm, launcher, { capacity: 1 });
		const answers: OfferAnswer[] = [];
		for (let i = 0; i < 3; i++)
			await answerOffer(
				mastermind(answers, { dispatch: null, reason: "taken" }),
				offerOf("mm-1"),
				{ runner: info, taker: r },
			);
		// Each offer was accepted: nothing stayed counted as busy.
		expect(answers.every((a) => a.accept)).toBe(true);
		await answerOffer(
			async () => {
				throw new Error("timeout");
			},
			offerOf("mm-2"),
			{ runner: info, taker: r },
		);
		mm.push(dispatch("mm-3"));
		await until(() => mm.verbs("complete").length === 1);
		expect(launcher.specs.map((s) => s.beadId)).toEqual(["mm-3"]);
	});
});
