// Worker readiness gate (mm-210.59): the dispatcher gives work only to a
// runner whose last status is ready, fresh and lists the item's environment.
import { describe, expect, test } from "bun:test";
import type { NextRequest, RunnerReadiness } from "@mastermind/core";
import {
	Dispatcher,
	type OfferExchange,
	READINESS_FRESH_MS,
	type RunnerStatusSeen,
} from "./dispatcher.ts";
import { fakeWork } from "./fake-work.ts";

const req = (id: string): NextRequest => ({
	runner: {
		id,
		account: "alice",
		serviceAccount: "alice-sa",
		providers: ["claude"],
		capabilities: [],
	},
});

const ready = (envs: string[], over: Partial<RunnerReadiness> = {}) => ({
	readiness: {
		state: "ready" as const,
		readyEnvironments: envs,
		failedChecks: [],
		checkedAt: "2026-11-12T08:00:00Z",
		...over,
	},
});

function setup(waitMs = 0) {
	let clock = new Date("2026-11-12T08:00:00Z");
	const now = () => clock;
	const work = fakeWork(now);
	const statuses = new Map<string, RunnerStatusSeen>();
	const offers: string[] = [];
	const d = new Dispatcher({
		work,
		now,
		waitMs,
		readiness: (account, runner) =>
			statuses.get(`${account}/${runner}`) ?? null,
		runnersOf: () => ["laptop"],
		offer: async (account, runner): Promise<OfferExchange> => {
			offers.push(`${account}/${runner}`);
			return { kind: "declined", reason: "test" };
		},
	});
	const report = (runner: string, status: RunnerStatusSeen["status"]) =>
		statuses.set(`alice/${runner}`, { status, receivedAt: clock.getTime() });
	const advance = (ms: number) => {
		clock = new Date(clock.getTime() + ms);
	};
	return { d, work, report, advance, offers };
}

describe("readiness gate", () => {
	test("no status: next answers notReady; nothing is claimed", async () => {
		const s = setup();
		s.work.add({ id: "mm-1" }, "build");
		const reply = await s.d.next("alice", "build", req("laptop"));
		expect(reply.dispatch).toBeNull();
		expect(reply.notReady?.[0]).toContain("no status");
		expect(s.work.beads.get("mm-1")?.assignee).toBeFalsy();
		expect(s.d.debug().decisions.at(-1)?.reason).toContain(
			"runner not ready: no status",
		);
	});

	test("not ready (onboarding, degraded): refused with the failed checks", async () => {
		const s = setup();
		s.work.add({ id: "mm-1" }, "build");
		s.report(
			"laptop",
			ready([], {
				state: "degraded",
				failedChecks: [{ check: "engine", problem: "Docker does not answer" }],
			}),
		);
		const reply = await s.d.next("alice", "build", req("laptop"));
		expect(reply).toEqual({
			dispatch: null,
			notReady: ["state degraded: Docker does not answer"],
		});
	});

	test("ready: items with no environment and of ready environments only", async () => {
		const s = setup();
		s.work.add({ id: "mm-api", priority: 0, labels: ["env:api"] }, "build");
		s.work.add({ id: "mm-web", priority: 1, labels: ["env:web"] }, "build");
		s.work.add({ id: "mm-none", priority: 2 }, "build");
		s.report("laptop", ready(["web"]));
		const first = await s.d.next("alice", "build", req("laptop"));
		expect(first.dispatch?.bead.id).toBe("mm-web");
		const second = await s.d.next("alice", "build", req("laptop"));
		expect(second.dispatch?.bead.id).toBe("mm-none");
		const third = await s.d.next("alice", "build", req("laptop"));
		expect(third.dispatch).toBeNull();
		expect(
			s.d.debug().decisions.find((x) => x.beadId === "mm-api")?.reason,
		).toBe("not ready: environment api is not ready on it");
	});

	test("a secret removed: the next status drops the environment and its work stops", async () => {
		const s = setup();
		s.report("laptop", ready(["web"]));
		s.work.add({ id: "mm-1", labels: ["env:web"] }, "build");
		s.report(
			"laptop",
			ready([], {
				failedChecks: [
					{
						check: "secrets",
						environment: "web",
						problem: "missing secrets: GH_TOKEN",
					},
				],
			}),
		);
		expect(
			(await s.d.next("alice", "build", req("laptop"))).dispatch,
		).toBeNull();
		expect(s.d.debug().decisions.at(-1)?.reason).toBe(
			"not ready: environment web is not ready on it: missing secrets: GH_TOKEN",
		);
	});

	test("a runner that lies is still refused when its status is stale", async () => {
		const s = setup();
		s.work.add({ id: "mm-1" }, "build");
		s.report("laptop", ready(["web"]));
		s.advance(READINESS_FRESH_MS + 1_000);
		const reply = await s.d.next("alice", "build", req("laptop"));
		expect(reply.dispatch).toBeNull();
		expect(reply.notReady?.[0]).toContain("121 s old");
	});

	test("next waits for readiness and then gets work", async () => {
		const s = setup(3_000);
		s.work.add({ id: "mm-1" }, "build");
		const pending = s.d.next("alice", "build", req("laptop"));
		await Bun.sleep(50);
		s.report("laptop", ready([]));
		expect((await pending).dispatch?.bead.id).toBe("mm-1");
	});

	test("direct: a runner that is not ready gets no offer; the note says why", async () => {
		const s = setup();
		s.work.add({ id: "mm-1", labels: ["to:alice"] });
		await s.d.direct("mm-1");
		expect(s.offers).toEqual([]);
		const notes = s.work.comments.filter((c) => c.id === "mm-1");
		expect(notes.at(-1)?.text).toContain(
			"alice/laptop: not ready: no status from the runner yet",
		);
		s.report("laptop", ready([]));
		s.advance(31_000);
		await s.d.direct("mm-1");
		expect(s.offers).toEqual(["alice/laptop"]);
	});
});
