import { describe, expect, test } from "bun:test";
import { BusError } from "@mastermind/bus";
import type { NextRequest, ReadyNotice, RunnerInfo } from "@mastermind/core";
import {
	checkActor,
	checkRunner,
	DECISIONS_KEPT,
	Dispatcher,
	type DispatchSeen,
	ENV_TRIAGE_LABEL,
	FAILED_START_LABEL,
} from "./dispatcher.ts";
import { fakeWork, LEASE_MS } from "./fake-work.ts";

const runner = (id: string, extra: Partial<RunnerInfo> = {}): NextRequest => ({
	runner: {
		id,
		account: "alice",
		serviceAccount: "alice-laptop",
		providers: ["claude"],
		capabilities: [],
		...extra,
	},
});

function setup(
	opts: { waitMs?: number; observe?: (seen: DispatchSeen) => void } = {},
) {
	let clock = new Date("2026-11-10T08:00:00Z");
	const now = () => clock;
	const work = fakeWork(now);
	const notices: ReadyNotice[] = [];
	const d: Dispatcher = new Dispatcher({
		work,
		now,
		waitMs: opts.waitMs ?? 0,
		observe: opts.observe,
		rules: () => [{ match: { type: "bug" }, queue: "fix" }],
		notify: (n) => {
			notices.push(n);
			void d.ready(n.queue);
		},
	});
	const advance = (ms: number) => {
		clock = new Date(clock.getTime() + ms);
	};
	return { d, work, notices, advance };
}

const code = (p: Promise<unknown>) =>
	p.then(
		() => "ok",
		(e) => (e instanceof BusError ? e.code : String(e)),
	);

describe("next", () => {
	test("dispatches the most urgent ready bead and claims it as account/runner", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1", priority: 3, description: "do it" }, "build");
		work.add({ id: "mm-2", priority: 1 }, "build");
		work.add({ id: "mm-3", priority: 0 }, "other");
		const { dispatch } = await d.next("alice", "build", runner("laptop"));
		expect(dispatch?.bead.id).toBe("mm-2");
		expect(dispatch?.actor).toBe("alice/laptop");
		expect(dispatch?.queue).toBe("build");
		expect(dispatch?.stage).toBe("work");
		// Labels come from the ready list, not the (label-less) claim reply.
		expect(dispatch?.bead.labels).toEqual(["queue:build"]);
		expect(dispatch?.lease.expiresAt).toBeString();
		expect(work.beads.get("mm-2")?.assignee).toBe("alice/laptop");
	});

	test("respects req: labels against runner capabilities", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1", priority: 0, labels: ["req:gpu"] }, "build");
		work.add({ id: "mm-2", priority: 2 }, "build");
		const plain = await d.next("alice", "build", runner("a"));
		expect(plain.dispatch?.bead.id).toBe("mm-2");
		expect(plain.dispatch?.env.requires).toEqual([]);
		const gpu = await d.next(
			"alice",
			"build",
			runner("b", { capabilities: ["gpu"] }),
		);
		expect(gpu.dispatch?.bead.id).toBe("mm-1");
		expect(gpu.dispatch?.env.requires).toEqual(["gpu"]);
	});

	test("no work and no wait: null", async () => {
		const { d } = setup();
		expect(await d.next("alice", "build", runner("a"))).toEqual({
			dispatch: null,
		});
	});

	test("two runners asking at once never get the same bead", async () => {
		const { d, work } = setup();
		work.claimDelayMs = 5;
		for (let i = 0; i < 3; i++) work.add({ id: `mm-${i}` }, "build");
		const replies = await Promise.all(
			["a", "b", "c", "d", "e"].map((id) =>
				d.next("alice", "build", runner(id)),
			),
		);
		const got = replies.map((r) => r.dispatch?.bead.id).filter(Boolean);
		expect(got.sort()).toEqual(["mm-0", "mm-1", "mm-2"]);
	});

	test("a lost claim race tries the next bead", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1", priority: 0 }, "build");
		work.add({ id: "mm-2", priority: 1 }, "build");
		// Another replica wins mm-1 between our read and our claim.
		const claim = work.claim;
		work.claim = async (id, actor) => {
			if (id === "mm-1") await claim(id, "bob/other");
			return claim(id, actor);
		};
		const { dispatch } = await d.next("alice", "build", runner("a"));
		expect(dispatch?.bead.id).toBe("mm-2");
	});

	test("rejects a runner of another account and malformed runners", async () => {
		const { d } = setup();
		expect(await code(d.next("bob", "build", runner("a")))).toBe("forbidden");
		expect(
			await code(d.next("alice", "build", {} as unknown as NextRequest)),
		).toBe("bad_request");
		expect(await code(d.next("alice", "build", runner("a/b")))).toBe(
			"bad_request",
		);
	});

	test("long poll: waits, then gets a bead that becomes ready", async () => {
		const { d, work } = setup({ waitMs: 5_000 });
		const pending = d.next("alice", "build", runner("a"));
		await Bun.sleep(1);
		expect(d.waiting("build")).toBe(1);
		const bead = work.add({ id: "mm-9" }, "build");
		await d.onEvent({
			seq: 1,
			at: "",
			op: "create",
			beadId: "mm-9",
			actor: "x",
			bead,
		});
		const { dispatch } = await pending;
		expect(dispatch?.bead.id).toBe("mm-9");
		expect(d.waiting()).toBe(0);
	});

	test("long poll: times out with null", async () => {
		const { d } = setup({ waitMs: 20 });
		expect(await d.next("alice", "build", runner("a"))).toEqual({
			dispatch: null,
		});
		expect(d.waiting()).toBe(0);
	});

	test("long poll: the account served least recently gets the new bead", async () => {
		const { d, work } = setup({ waitMs: 5_000 });
		work.add({ id: "mm-1" }, "build");
		// alice was just served.
		await d.next("alice", "build", runner("a"));
		const alice = d.next("alice", "build", runner("a"));
		const bob = d.next("bob", "build", {
			runner: { ...runner("b").runner, account: "bob" },
		});
		await Bun.sleep(1);
		expect(d.waiting("build")).toBe(2);
		work.add({ id: "mm-2" }, "build");
		await d.ready("build");
		expect((await bob).dispatch?.bead.id).toBe("mm-2");
		d.stop();
		expect((await alice).dispatch).toBeNull();
	});
});

describe("bead verbs", () => {
	async function held() {
		const s = setup();
		s.work.add({ id: "mm-1.2" }, "build");
		await s.d.next("alice", "build", runner("a"));
		return s;
	}
	const actor = "alice/a";

	test("heartbeat renews the lease", async () => {
		const { d, advance } = await held();
		advance(60_000);
		const { lease } = await d.heartbeat("alice", "mm-1.2", { actor });
		expect(Date.parse(lease.expiresAt)).toBe(
			Date.parse("2026-11-10T08:01:00Z") + LEASE_MS,
		);
	});

	test("report comments, complete closes", async () => {
		const { d, work } = await held();
		expect(
			await d.report("alice", "mm-1.2", { actor, message: "50%" }),
		).toEqual({
			ok: true,
		});
		expect(work.comments).toEqual([{ id: "mm-1.2", actor, text: "50%" }]);
		await d.complete("alice", "mm-1.2", { actor, summary: "done" });
		expect(work.beads.get("mm-1.2")?.status).toBe("closed");
		// Idempotent.
		expect(
			await d.complete("alice", "mm-1.2", { actor, summary: "done" }),
		).toEqual({
			ok: true,
		});
	});

	test("release gives the bead back and announces the queue", async () => {
		const { d, work, notices } = await held();
		await d.release("alice", "mm-1.2", { actor, reason: "env missing" });
		expect(work.beads.get("mm-1.2")?.status).toBe("open");
		expect(notices.map((n) => [n.queue, n.beadId])).toEqual([
			["build", "mm-1.2"],
		]);
	});

	test("only the holder may act; actor must be in the subject's account", async () => {
		const { d } = await held();
		expect(
			await code(d.heartbeat("alice", "mm-1.2", { actor: "alice/b" })),
		).toBe("conflict");
		expect(
			await code(d.complete("bob", "mm-1.2", { actor, summary: "x" })),
		).toBe("forbidden");
		expect(
			await code(d.report("alice", "mm-nope", { actor, message: "x" })),
		).toBe("not_found");
		expect(await code(d.report("alice", "mm-1.2", { actor } as never))).toBe(
			"bad_request",
		);
	});
});

describe("no hot loop after a release (mm-sih)", () => {
	const actor = "alice/a";
	const take = (d: Dispatcher, id = "a") =>
		d.next("alice", "build", runner(id)).then((r) => r.dispatch?.bead.id);

	test("the same runner gets a released bead again after 1 min, 5 min, then never", async () => {
		const { d, work, advance } = setup();
		work.add({ id: "mm-1" }, "build");
		const release = () =>
			d.release("alice", "mm-1", { actor, reason: "no", startFailed: false });
		expect(await take(d)).toBe("mm-1");
		await release();
		expect(await take(d)).toBeUndefined();
		advance(59_000);
		expect(await take(d)).toBeUndefined();
		advance(1_000);
		expect(await take(d)).toBe("mm-1");
		await release();
		advance(299_000);
		expect(await take(d)).toBeUndefined();
		advance(1_000);
		expect(await take(d)).toBe("mm-1");
		await release();
		advance(24 * 3600_000);
		expect(await take(d)).toBeUndefined();
		// Another runner is not held back.
		expect(await take(d, "b")).toBe("mm-1");
	});

	test("a waiting runner in back-off is not woken with that bead", async () => {
		const { d, work } = setup({ waitMs: 50 });
		work.add({ id: "mm-1" }, "build");
		expect(await take(d)).toBe("mm-1");
		const again = take(d);
		await d.release("alice", "mm-1", { actor, reason: "no" });
		expect(await again).toBeUndefined();
		expect(work.beads.get("mm-1")?.assignee).toBeUndefined();
	});

	test("3 failed starts: failed:start, a note with the last reason; reopen (label gone) clears it", async () => {
		const { d, work, advance } = setup();
		work.add({ id: "mm-1" }, "build");
		for (const id of ["a", "b", "c"]) {
			expect(await take(d, id)).toBe("mm-1");
			await d.release("alice", "mm-1", {
				actor: `alice/${id}`,
				reason: `MISSING_PROVIDER on ${id}`,
				startFailed: true,
			});
		}
		const bead = work.beads.get("mm-1");
		expect(bead?.labels).toContain(FAILED_START_LABEL);
		expect(work.comments.at(-1)?.text).toBe(
			"not dispatched: the agent failed to start 3 times; last: MISSING_PROVIDER on c. Reopen to try again.",
		);
		expect(await take(d, "d")).toBeUndefined();
		// A human removes the label: every runner may take it again at once.
		await work.setLabels(
			"mm-1",
			"alice",
			(bead?.labels ?? []).filter((l) => l !== FAILED_START_LABEL),
		);
		advance(1);
		expect(await take(d, "a")).toBe("mm-1");
	});

	test("releases that are not failed starts never set failed:start", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1" }, "build");
		for (const id of ["a", "b", "c", "d"]) {
			expect(await take(d, id)).toBe("mm-1");
			await d.release("alice", "mm-1", {
				actor: `alice/${id}`,
				reason: "declined",
			});
		}
		expect(work.beads.get("mm-1")?.labels).not.toContain(FAILED_START_LABEL);
	});
});

describe("sweep", () => {
	test("returns beads with a dead lease to their queue, keeps live ones", async () => {
		const { d, work, notices, advance } = setup();
		work.add({ id: "mm-1" }, "build");
		work.add({ id: "mm-2" }, "build");
		// Claimed by a human outside any queue: never swept.
		work.add({ id: "mm-3" });
		await work.claim("mm-3", "rocky");
		await d.next("alice", "build", runner("a"));
		advance(LEASE_MS - 1_000);
		await d.next("alice", "build", runner("b"));
		advance(2_000);
		expect(await d.sweep()).toEqual(["mm-1"]);
		expect(work.beads.get("mm-1")?.status).toBe("open");
		expect(work.beads.get("mm-2")?.status).toBe("in_progress");
		expect(work.beads.get("mm-3")?.status).toBe("in_progress");
		expect(notices.map((n) => n.beadId)).toEqual(["mm-1"]);
	});

	test("a task that heartbeats outlives the lease TTL", async () => {
		const { d, work, advance } = setup();
		work.add({ id: "mm-1" }, "build");
		await d.next("alice", "build", runner("a"));
		for (let i = 0; i < 4; i++) {
			advance(LEASE_MS / 2);
			await d.heartbeat("alice", "mm-1", { actor: "alice/a" });
		}
		advance(LEASE_MS / 2);
		expect(await d.sweep()).toEqual([]);
		expect(work.beads.get("mm-1")?.status).toBe("in_progress");
	});
});

describe("routing on journal events", () => {
	test("an unrouted open bead gets the queue of the first matching rule", async () => {
		const { d, work } = setup();
		const bug = work.add({ id: "mm-1", type: "bug" });
		const task = work.add({ id: "mm-2", type: "task" });
		for (const bead of [bug, task]) {
			await d.onEvent({
				seq: 1,
				at: "",
				op: "create",
				beadId: bead.id,
				actor: "x",
				bead,
			});
		}
		expect(work.beads.get("mm-1")?.labels).toEqual(["queue:fix"]);
		expect(work.beads.get("mm-2")?.labels).toEqual([]);
	});

	test("a stale event does not undo a manual queue", async () => {
		const { d, work } = setup();
		const bug = work.add({ id: "mm-1", type: "bug" });
		// Somebody moved the bead to 'web' after this event was journaled.
		work.beads.set("mm-1", { ...bug, labels: ["queue:web"] });
		await d.onEvent({
			seq: 1,
			at: "",
			op: "update",
			beadId: "mm-1",
			actor: "x",
			bead: bug,
		});
		expect(work.beads.get("mm-1")?.labels).toEqual(["queue:web"]);
	});

	test("a ready bead on a queue announces the queue; others do not", async () => {
		const { d, work, notices } = setup();
		const ready = work.add({ id: "mm-1" }, "build");
		const blocked = work.add({ id: "mm-2", blocked: true }, "build");
		for (const bead of [ready, blocked]) {
			await d.onEvent({
				seq: 1,
				at: "",
				op: "update",
				beadId: bead.id,
				actor: "x",
				bead,
			});
		}
		expect(notices.map((n) => n.beadId)).toEqual(["mm-1"]);
	});
});

test("checkActor and checkRunner", () => {
	expect(checkActor("alice", "alice/a")).toBe("alice/a");
	expect(() => checkActor("alice", "alice/")).toThrow(BusError);
	expect(() => checkActor("alice", "alicex/a")).toThrow(BusError);
	expect(() => checkActor("alice", "alice/a/b")).toThrow(BusError);
	expect(checkRunner("alice", runner("a")).id).toBe("a");
});

describe("observe", () => {
	test("tells who asked, who holds what and who let go", async () => {
		const seen: DispatchSeen[] = [];
		const { d, work, advance } = setup({ observe: (s) => seen.push(s) });
		work.add({ id: "mm-1" }, "build");
		work.add({ id: "mm-2" }, "build");
		await d.next("alice", "build", runner("a", { capacity: 2 }));
		await d.heartbeat("alice", "mm-1", { actor: "alice/a" });
		await d.complete("alice", "mm-1", { actor: "alice/a", summary: "ok" });
		await d.next("alice", "build", runner("a"));
		advance(LEASE_MS + 1_000);
		await d.sweep();
		expect(
			seen.map((s) =>
				s.kind === "next"
					? [s.kind, s.runner.capacity]
					: [s.kind, s.actor, s.beadId],
			),
		).toEqual([
			["next", 2],
			["holds", "alice/a", "mm-1"],
			["holds", "alice/a", "mm-1"],
			["done", "alice/a", "mm-1"],
			["next", undefined],
			["holds", "alice/a", "mm-2"],
			["done", "alice/a", "mm-2"],
		]);
	});

	test("an observer that throws does not break dispatch", async () => {
		const errors: unknown[] = [];
		const work = fakeWork(() => new Date("2026-11-10T08:00:00Z"));
		work.add({ id: "mm-1" }, "build");
		const d = new Dispatcher({
			work,
			waitMs: 0,
			observe: () => {
				throw new Error("boom");
			},
			onError: (e) => errors.push(e),
		});
		const { dispatch } = await d.next("alice", "build", runner("a"));
		expect(dispatch?.bead.id).toBe("mm-1");
		expect(errors.length).toBe(2);
	});
});

describe("dispatch envelope from the bead (mm-210.26)", () => {
	test("env comes from repo:/ref:/provider:/req: labels; prompt has acceptance and human notes", async () => {
		const { d, work } = setup();
		work.add(
			{
				id: "mm-9",
				description: "do it",
				acceptance: "tests pass",
				labels: [
					"repo:https://github.com/x/y.git",
					"ref:dev",
					"provider:claude",
				],
			},
			"build",
		);
		work.notes = async (id) => [
			{
				id: "n1",
				beadId: id,
				author: "duke",
				text: "use bun",
				createdAt: "t1",
			},
			{
				id: "n2",
				beadId: id,
				author: "alice/old",
				text: "a report",
				createdAt: "t2",
			},
		];
		const { dispatch } = await d.next("alice", "build", runner("laptop"));
		expect(dispatch?.env).toEqual({
			repo: "https://github.com/x/y.git",
			ref: "dev",
			provider: "claude",
			requires: [],
		});
		expect(dispatch?.prompt).toBe(
			"mm-9\n\ndo it\n\nAcceptance:\ntests pass\n\nNotes:\n- duke (t1): use bun",
		);
	});
});

describe("named environments", () => {
	const scratch = {
		name: "scratch",
		repo: "https://github.com/acme/scratch.git",
		ref: "main",
		requires: [],
		setup: ["bun install"],
		check: ["bun test"],
		instructions: "Keep commits small.",
	};
	function envSetup() {
		const clock = new Date("2026-11-10T08:00:00Z");
		const work = fakeWork(() => clock);
		const d = new Dispatcher({
			work,
			now: () => clock,
			waitMs: 0,
			resolveEnv: (bead) =>
				bead.labels.includes("env:scratch")
					? { ok: true, env: scratch }
					: { ok: false, reason: "environment nope is not defined" },
		});
		return { d, work };
	}

	test("the envelope carries the resolved environment; instructions go into the prompt", async () => {
		const { d, work } = envSetup();
		work.add({ id: "mm-1", labels: ["env:scratch"] }, "build");
		const { dispatch } = await d.next("alice", "build", runner("laptop"));
		expect(dispatch?.env).toEqual(scratch);
		expect(dispatch?.prompt).toEndWith(
			"Environment scratch instructions:\nKeep commits small.",
		);
	});

	test("an unknown environment is not dispatched; the bead is marked once with the reason", async () => {
		const { d, work } = envSetup();
		work.add({ id: "mm-1", priority: 0, labels: ["env:nope"] }, "build");
		work.add({ id: "mm-2", priority: 2, labels: ["env:scratch"] }, "build");
		const first = await d.next("alice", "build", runner("a"));
		expect(first.dispatch?.bead.id).toBe("mm-2");
		const held = work.beads.get("mm-1");
		expect(held?.status).toBe("open");
		expect(held?.labels).toContain(ENV_TRIAGE_LABEL);
		expect(work.comments.filter((c) => c.id === "mm-1")).toEqual([
			{
				id: "mm-1",
				actor: "mastermind",
				text: "not dispatched: environment nope is not defined",
			},
		]);
		// Asked again: still not dispatched, no second note.
		const again = await d.next("alice", "build", runner("b"));
		expect(again.dispatch).toBeNull();
		expect(work.comments.filter((c) => c.id === "mm-1")).toHaveLength(1);
	});

	test("the mark is removed when the environment resolves", async () => {
		const { d, work } = envSetup();
		work.add(
			{ id: "mm-1", labels: ["env:scratch", ENV_TRIAGE_LABEL] },
			"build",
		);
		const { dispatch } = await d.next("alice", "build", runner("a"));
		expect(dispatch?.bead.labels).not.toContain(ENV_TRIAGE_LABEL);
		expect(work.beads.get("mm-1")?.labels).not.toContain(ENV_TRIAGE_LABEL);
	});

	test("a runner that lists its environments is offered only those", async () => {
		const { d, work } = envSetup();
		work.add({ id: "mm-1", labels: ["env:scratch"] }, "build");
		const other = await d.next(
			"alice",
			"build",
			runner("a", { environments: ["docs"] }),
		);
		expect(other.dispatch).toBeNull();
		expect(work.beads.get("mm-1")?.status).toBe("open");
		const bound = await d.next(
			"alice",
			"build",
			runner("b", { environments: ["scratch"] }),
		);
		expect(bound.dispatch?.bead.id).toBe("mm-1");
	});

	test("a waiting runner without the environment is not woken for it", async () => {
		const clock = new Date("2026-11-10T08:00:00Z");
		const work = fakeWork(() => clock);
		const d = new Dispatcher({
			work,
			now: () => clock,
			waitMs: 200,
			resolveEnv: () => ({ ok: true, env: { ...scratch } }),
		});
		const waiting = d.next(
			"alice",
			"build",
			runner("a", { environments: ["docs"] }),
		);
		await Bun.sleep(10);
		work.add({ id: "mm-1", labels: ["env:scratch"] }, "build");
		await d.ready("build");
		expect((await waiting).dispatch).toBeNull();
		expect(work.beads.get("mm-1")?.status).toBe("open");
	});

	test("environments must be a list of names", async () => {
		const { d } = envSetup();
		const bad = runner("a", {
			environments: "scratch" as unknown as string[],
		});
		await expect(d.next("alice", "build", bad)).rejects.toThrow(
			"runner is missing or malformed",
		);
	});
});

describe("debug view (mm-bcm)", () => {
	const take = (d: Dispatcher, id = "a", queue = "build") =>
		d.next("alice", queue, runner(id)).then((r) => r.dispatch?.bead.id);

	test("waiters per queue with since; empty again after the wait", async () => {
		const { d } = setup({ waitMs: 30 });
		const waiting = take(d, "a", "idle");
		await Bun.sleep(1);
		expect(d.debug().waiters).toEqual({
			idle: [{ actor: "alice/a", since: "2026-11-10T08:00:00.000Z" }],
		});
		expect(await waiting).toBeUndefined();
		expect(d.debug().waiters).toEqual({});
	});

	test("offers, back-off declines (counted, not repeated), lost races, failed:start", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1" }, "build");
		expect(await take(d)).toBe("mm-1");
		await d.release("alice", "mm-1", { actor: "alice/a", reason: "no" });
		await take(d);
		await take(d);
		const { decisions } = d.debug();
		expect(decisions.map((x) => [x.kind, x.beadId, x.actor, x.count])).toEqual([
			["offer", "mm-1", "alice/a", 1],
			["decline", "mm-1", "alice/a", 2],
		]);
		expect(decisions[0]?.reason).toStartWith("claimed (on next)");
		expect(decisions[1]?.reason).toBe(
			"back-off after release 1 until 2026-11-10T08:01:00.000Z",
		);

		work.add({ id: "mm-2", priority: 0 }, "build");
		const claim = work.claim;
		work.claim = async (id, actor) => {
			if (id === "mm-2") await claim(id, "bob/other");
			return claim(id, actor);
		};
		await take(d, "b");
		expect(d.debug().decisions.at(-2)).toMatchObject({
			kind: "decline",
			beadId: "mm-2",
			actor: "alice/b",
			reason: "lost the claim race (claimed by another)",
		});

		work.add({ id: "mm-3", labels: [FAILED_START_LABEL] }, "build");
		await take(d, "c");
		expect(d.debug().decisions.find((x) => x.beadId === "mm-3")).toMatchObject({
			kind: "decline",
			reason: `held back: label ${FAILED_START_LABEL} (reopen to try again)`,
		});
		expect(d.debug().decisions.find((x) => x.beadId === "mm-3")?.actor).toBe(
			undefined,
		);
	});

	test("an environment the runner has not bound is a decline with the reason", async () => {
		const { d, work } = setup();
		work.add({ id: "mm-1", labels: ["env:web"] }, "build");
		await d.next("alice", "build", runner("a", { environments: ["api"] }));
		expect(d.debug().decisions).toMatchObject([
			{
				kind: "decline",
				beadId: "mm-1",
				actor: "alice/a",
				reason: "environment not bound by the runner (bound: api)",
			},
		]);
	});

	test("keeps the last DECISIONS_KEPT decisions", async () => {
		const { d, work } = setup();
		for (let i = 0; i <= DECISIONS_KEPT; i++) {
			work.add({ id: `mm-${i}` }, "build");
			await take(d, `r${i}`);
		}
		const { decisions } = d.debug();
		expect(decisions).toHaveLength(DECISIONS_KEPT);
		expect(decisions[0]?.beadId).toBe("mm-1");
	});
});
