// Direct delivery (mm-210.32): a bead with to:<address> is offered to one
// runner, or to each online runner of an account, until one accepts.
import { describe, expect, test } from "bun:test";
import type {
	BeadEvent,
	DirectOffer,
	OfferResult,
	RunnerInfo,
} from "@mastermind/core";
import { NOT_ACCEPTED_LABEL } from "@mastermind/core";
import type { RoutingRule } from "@mastermind/router";
import { Dispatcher, type OfferExchange } from "./dispatcher.ts";
import { fakeWork } from "./fake-work.ts";

type Answer = "accept" | "offline" | "timeout" | { decline: string };

const info = (account: string, id: string): RunnerInfo => ({
	id,
	account,
	serviceAccount: `${account}-sa`,
	providers: ["claude"],
	capabilities: [],
});

function setup(
	opts: {
		answers?: Record<string, Answer>;
		online?: Record<string, string[]>;
		rules?: RoutingRule[];
	} = {},
) {
	let clock = new Date("2026-11-12T08:00:00Z");
	const now = () => clock;
	const work = fakeWork(now);
	const offers: { actor: string; offer: DirectOffer }[] = [];
	const results: { actor: string; result: OfferResult }[] = [];
	const answers = opts.answers ?? {};
	const d = new Dispatcher({
		work,
		now,
		waitMs: 0,
		retryMs: 30_000,
		rules: () => opts.rules ?? [],
		runnersOf: (account) => opts.online?.[account] ?? [],
		offer: async (account, runner, offer): Promise<OfferExchange> => {
			const actor = `${account}/${runner}`;
			offers.push({ actor, offer });
			const a = answers[actor] ?? "offline";
			if (a === "offline") return { kind: "offline" };
			if (a === "timeout") return { kind: "timeout" };
			if (a === "accept")
				return {
					kind: "accepted",
					runner: info(account, runner),
					reply: (result) => results.push({ actor, result }),
				};
			return { kind: "declined", reason: a.decline };
		},
	});
	const advance = (ms: number) => {
		clock = new Date(clock.getTime() + ms);
	};
	const event = (id: string): BeadEvent => ({
		seq: 1,
		at: clock.toISOString(),
		op: "update",
		beadId: id,
		actor: "alice",
		bead: structuredClone(work.beads.get(id)),
	});
	const notes = (id: string) =>
		work.comments.filter((c) => c.id === id).map((c) => c.text);
	return { d, work, offers, results, advance, event, notes, answers };
}

describe("direct delivery", () => {
	test("to bob/laptop: offered to that runner only; accept claims it and returns the dispatch", async () => {
		const s = setup({
			answers: { "bob/laptop": "accept", "bob/desk": "accept" },
			online: { bob: ["desk", "laptop"] },
		});
		s.work.add({ id: "mm-1", labels: ["to:bob/laptop"] });
		await s.d.onEvent(s.event("mm-1"));
		expect(s.offers.map((o) => o.actor)).toEqual(["bob/laptop"]);
		const offer = s.offers[0]?.offer;
		expect(offer?.queue).toBe("to:bob/laptop");
		expect(offer?.address).toBe("bob/laptop");
		expect(offer?.bead.id).toBe("mm-1");
		const r = s.results[0]?.result;
		expect(r?.dispatch?.actor).toBe("bob/laptop");
		expect(r?.dispatch?.queue).toBe("to:bob/laptop");
		expect(s.work.beads.get("mm-1")?.assignee).toBe("bob/laptop");
		expect(s.notes("mm-1")).toEqual([
			"sent to bob/laptop: bob/laptop accepted",
		]);
		expect(s.d.debug().decisions.at(-1)).toMatchObject({
			kind: "offer",
			actor: "bob/laptop",
		});
	});

	test("to bob: online runners in least-recently-served order; a decline shows its reason and the next one gets the offer", async () => {
		const s = setup({
			answers: {
				"bob/laptop": { decline: "at capacity" },
				"bob/desk": "accept",
			},
			online: { bob: ["desk", "laptop"], carol: ["box"] },
		});
		s.work.add({ id: "mm-1", labels: ["to:bob"] });
		await s.d.direct("mm-1");
		// Neither was served: by id.
		expect(s.offers.map((o) => o.actor)).toEqual(["bob/desk"]);
		// desk is now the most recently served: laptop comes first.
		s.work.add({ id: "mm-2", labels: ["to:bob"] });
		await s.d.direct("mm-2");
		expect(s.offers.slice(1).map((o) => o.actor)).toEqual([
			"bob/laptop",
			"bob/desk",
		]);
		expect(s.work.beads.get("mm-2")?.assignee).toBe("bob/desk");
		expect(s.notes("mm-2")).toEqual([
			"sent to bob: bob/laptop: declined: at capacity; bob/desk accepted",
		]);
	});

	test("offline address: the bead waits, marked, with the reason; no repeat note; offered again after retryMs", async () => {
		const s = setup({ online: { bob: [] } });
		s.work.add({ id: "mm-1", labels: ["to:bob/laptop"] });
		await s.d.direct("mm-1");
		const bead = s.work.beads.get("mm-1");
		expect(bead?.status).toBe("open");
		expect(bead?.labels).toEqual(["to:bob/laptop", NOT_ACCEPTED_LABEL]);
		expect(s.notes("mm-1")).toEqual([
			"not accepted by bob/laptop: bob/laptop: offline (nobody answers its offer subject; a runner older than mm-210.32 does not take offers). It waits; offered again every 30 s.",
		]);
		// Its own label change does not start a new round.
		await s.d.onEvent(s.event("mm-1"));
		await s.d.retryDirect();
		expect(s.offers).toHaveLength(1);
		// After retryMs, still offline: offered again, no new note.
		s.advance(30_000);
		await s.d.retryDirect();
		expect(s.offers).toHaveLength(2);
		expect(s.notes("mm-1")).toHaveLength(1);
		// The runner comes back and accepts: the mark goes.
		s.answers["bob/laptop"] = "accept";
		s.advance(30_000);
		await s.d.retryDirect();
		expect(s.work.beads.get("mm-1")?.assignee).toBe("bob/laptop");
		expect(s.work.beads.get("mm-1")?.labels).toEqual(["to:bob/laptop"]);
	});

	test("an account with no online runner: the reason says so", async () => {
		const s = setup();
		s.work.add({ id: "mm-1", labels: ["to:bob"] });
		await s.d.direct("mm-1");
		expect(s.offers).toHaveLength(0);
		expect(s.notes("mm-1")[0]).toStartWith(
			"not accepted by bob: no runner of bob is online.",
		);
	});

	test("timeout and decline go to the next runner; fallback: queue moves the bead there", async () => {
		const s = setup({
			answers: { "bob/a": "timeout", "bob/b": { decline: "env x not bound" } },
			online: { bob: ["a", "b"] },
			rules: [{ match: { labels: ["web"] }, to: "bob", fallback: "build" }],
		});
		s.work.add({ id: "mm-1", labels: ["web"] });
		await s.d.onEvent(s.event("mm-1"));
		// The rule labels it to:bob; that label change is the next event.
		expect(s.work.beads.get("mm-1")?.labels).toEqual(["web", "to:bob"]);
		await s.d.onEvent(s.event("mm-1"));
		expect(s.offers.map((o) => o.actor)).toEqual(["bob/a", "bob/b"]);
		expect(s.work.beads.get("mm-1")?.labels).toEqual(["web", "queue:build"]);
		expect(s.notes("mm-1")).toEqual([
			"not accepted by bob: bob/a: no answer in time; bob/b: declined: env x not bound. Fallback: queue build.",
		]);
	});

	test("a runner that released the bead backs off; a dead direct lease is swept", async () => {
		const s = setup({
			answers: { "bob/laptop": "accept" },
			online: { bob: ["laptop"] },
		});
		s.work.add({ id: "mm-1", labels: ["to:bob"] });
		await s.d.direct("mm-1");
		await s.d.release("bob", "mm-1", { actor: "bob/laptop", reason: "nope" });
		await s.d.direct("mm-1");
		expect(s.offers).toHaveLength(1);
		expect(s.notes("mm-1").at(-1)).toContain(
			"bob/laptop: back-off after release 1",
		);
		// After the back-off it is offered again; then the lease dies.
		s.advance(61_000);
		await s.d.retryDirect();
		expect(s.work.beads.get("mm-1")?.assignee).toBe("bob/laptop");
		s.advance(6 * 60_000);
		expect(await s.d.sweep()).toEqual(["mm-1"]);
	});

	test("somebody else took it between offer and claim: the runner gets null with the reason", async () => {
		const s = setup({ answers: { "bob/laptop": "accept" } });
		s.work.add({ id: "mm-1", labels: ["to:bob/laptop"] });
		s.work.claimDelayMs = 1;
		const claim = s.work.claim.bind(s.work);
		s.work.claim = async (id, actor) => {
			await claim(id, "carol/box");
			return claim(id, actor);
		};
		await s.d.direct("mm-1");
		expect(s.results[0]?.result).toEqual({
			dispatch: null,
			reason: "somebody else took the bead",
		});
	});
});

describe("Presence", () => {
	test("online runners of an account, heard within onlineMs", async () => {
		const { Presence } = await import("./offer.ts");
		let t = 0;
		const p = new Presence(90_000, () => t);
		p.seen("bob", "laptop");
		p.seen("bob", "desk");
		p.seen("carol", "box");
		t = 60_000;
		p.seen("bob", "laptop");
		expect(p.online("bob")).toEqual(["desk", "laptop"]);
		t = 120_000;
		expect(p.online("bob")).toEqual(["laptop"]);
		expect(p.online("nobody")).toEqual([]);
	});
});
