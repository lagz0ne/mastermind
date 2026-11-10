import { describe, expect, test } from "bun:test";
import { BusError } from "@mastermind/bus";
import type { NextRequest, ReadyNotice, RunnerInfo } from "@mastermind/core";
import {
	checkActor,
	checkRunner,
	Dispatcher,
	type DispatchSeen,
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
