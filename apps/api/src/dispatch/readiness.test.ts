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

describe("two processes of one runner id (mm-210.79, P0 mm-awdc)", () => {
	// Production 08:55Z: the new process (1948c46) published a ready status;
	// the old one (700dcda, no box, no environments, no session) asked `next`
	// under the same runner id and got the item on the new one's status.
	const oldReq = (): NextRequest => ({
		runner: { ...req("yo-buid").runner, version: "700dcda" },
	});
	const newReq = (extra = {}): NextRequest => ({
		runner: {
			...req("yo-buid").runner,
			version: "1948c46",
			environments: ["scratch"],
			...extra,
		},
	});

	test("next: the old process does not pass on the new process's ready status", async () => {
		const { d, work, report } = setup();
		work.add({ id: "mm-awdc", labels: ["env:scratch"] }, "build");
		report("yo-buid", { ...ready(["scratch"]), version: "1948c46" });
		const r = await d.next("alice", "build", oldReq());
		expect(r.dispatch).toBeNull();
		expect(r.notReady?.[0]).toStartWith(
			"its last status is from another process of this runner (version 1948c46; this request: version 700dcda)",
		);
		expect(work.beads.get("mm-awdc")?.assignee).toBeFalsy();
		expect((await d.next("alice", "build", newReq())).dispatch?.bead.id).toBe(
			"mm-awdc",
		);
	});

	test("waiter woken: the old process waiting while the new one reports ready is not woken", async () => {
		const { d, work, report } = setup(5_000);
		// The old one passed the runner-wide check once (its own status said
		// ready), then the new process's status came.
		report("yo-buid", { ...ready([]), version: "700dcda" });
		const older = d.next("alice", "build", oldReq());
		await Bun.sleep(5);
		report("yo-buid", { ...ready(["scratch"]), version: "1948c46" });
		work.add({ id: "mm-awdc", labels: ["env:scratch"] }, "build");
		await d.ready("build");
		expect(work.beads.get("mm-awdc")?.assignee).toBeFalsy();
		d.stop();
		expect((await older).dispatch).toBeNull();
	});

	test("with sessions: the status must carry the asking process's session", async () => {
		const { d, work, report } = setup();
		work.add({ id: "mm-1" }, "build");
		report("yo-buid", {
			...ready([]),
			version: "d306f8f",
			session: "bbbb-new",
		});
		const other = await d.next(
			"alice",
			"build",
			newReq({
				version: "d306f8f",
				session: "cccc-x",
				startedAt: "2026-11-12T07:00:00Z",
			}),
		);
		expect(other.dispatch).toBeNull();
		const same = await d.next(
			"alice",
			"build",
			newReq({
				version: "d306f8f",
				session: "bbbb-new",
				startedAt: "2026-11-12T08:00:00Z",
			}),
		);
		expect(same.dispatch?.bead.id).toBe("mm-1");
	});

	test("offer: an accept from the other process is refused, nothing is claimed", async () => {
		let clock = new Date("2026-11-12T08:00:00Z");
		const work = fakeWork(() => clock);
		const replies: unknown[] = [];
		const d = new Dispatcher({
			work,
			now: () => clock,
			waitMs: 0,
			readiness: () => ({
				status: { ...ready(["scratch"]), version: "1948c46" },
				receivedAt: clock.getTime(),
			}),
			runnersOf: () => ["yo-buid"],
			offer: async (): Promise<OfferExchange> => ({
				kind: "accepted",
				runner: oldReq().runner,
				reply: (r) => replies.push(r),
			}),
		});
		work.add({ id: "mm-d1", labels: ["to:alice/yo-buid", "env:scratch"] });
		await d.direct("mm-d1");
		expect(work.beads.get("mm-d1")?.assignee).toBeFalsy();
		expect(replies).toEqual([
			{
				dispatch: null,
				reason: expect.stringContaining("another process of this runner"),
			},
		]);
		clock = new Date(clock.getTime() + 1);
	});
});
