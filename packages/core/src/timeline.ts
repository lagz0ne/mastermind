/**
 * The story of one bead, folded from its events journal: created, routed to a
 * queue, claimed, reports, released, completed, closed, reopened. The api
 * folds the whole journal of a bead; the web keeps folding live events.
 */
import { type Bead, type BeadEvent, type Lease, queueOf } from "./work.ts";

export const TIMELINE_KINDS = [
	"created",
	"routed",
	"claimed",
	"report",
	"note",
	"released",
	"completed",
	"closed",
	"reopened",
	"updated",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineEntry = {
	/** Journal seq; with `kind` it is unique in a timeline. */
	seq: number;
	at: string;
	beadId: string;
	kind: TimelineKind;
	/** Who did it: an account, `<account>/<agent>`, or `mastermind`. */
	actor: string;
	/** report and note: the text; released: the reason; completed and closed: the result. */
	text?: string;
	/** routed: the queue. */
	queue?: string;
	/** claimed and released: the holder. */
	holder?: string;
	/** claimed: the lease it got. */
	lease?: Lease;
};

/** What the fold carries from one event to the next. */
export type TimelineState = {
	/** The bead after the last event; undefined before the first one. */
	bead?: Bead;
	entries: TimelineEntry[];
	/** Reason of a release that the next release event uses. */
	releaseReason?: string;
};

/** A dispatcher release writes `released: <reason>` just before it releases. */
export const RELEASE_PREFIX = "released: ";

/** True for `<account>/<agent>`: a runner acting for an agent, not a human. */
export function isAgentActor(actor: string): boolean {
	return actor.includes("/");
}

function holds(bead: Bead | undefined): string | undefined {
	return bead?.status === "in_progress" || bead?.status === "hooked"
		? bead.assignee
		: undefined;
}

/** Fold one event into the timeline. Pure: returns a new state. */
export function stepTimeline(
	state: TimelineState,
	event: BeadEvent,
): TimelineState {
	const prev = state.bead;
	const next = event.bead;
	const base = { seq: event.seq, at: event.at, beadId: event.beadId };
	const out: TimelineEntry[] = [];
	let releaseReason = state.releaseReason;
	const add = (entry: Omit<TimelineEntry, "seq" | "at" | "beadId">) =>
		out.push({ ...base, ...entry });

	switch (event.op) {
		case "create":
			add({ kind: "created", actor: event.actor });
			break;
		case "comment": {
			const c = event.comment;
			if (!c) break;
			if (isAgentActor(c.author) && c.text.startsWith(RELEASE_PREFIX)) {
				releaseReason = c.text.slice(RELEASE_PREFIX.length);
				break;
			}
			add({
				kind: isAgentActor(c.author) ? "report" : "note",
				actor: c.author,
				text: c.text,
			});
			break;
		}
		case "close": {
			const holder = holds(prev) ?? prev?.assignee;
			add({
				kind: holder && holder === event.actor ? "completed" : "closed",
				actor: event.actor,
				...(next?.closeReason ? { text: next.closeReason } : {}),
			});
			break;
		}
		default: {
			if (!next) break;
			if (!prev) {
				// No earlier state (a window of the journal): say what it is now.
				add({ kind: "updated", actor: event.actor });
				break;
			}
			const queue = queueOf(next);
			if (queue && queue !== queueOf(prev)) {
				add({ kind: "routed", actor: event.actor, queue });
			}
			if (prev.status === "closed" && next.status !== "closed") {
				add({ kind: "reopened", actor: event.actor });
			}
			const was = holds(prev);
			const now = holds(next);
			if (was && was !== now) {
				add({
					kind: "released",
					actor: event.actor,
					holder: was,
					...(releaseReason ? { text: releaseReason } : {}),
				});
				releaseReason = undefined;
			}
			if (now && now !== was) {
				add({
					kind: "claimed",
					actor: event.actor,
					holder: now,
					...(next.lease ? { lease: next.lease } : {}),
				});
			}
		}
	}
	const result: TimelineState = {
		bead: event.op === "delete" ? undefined : (next ?? prev),
		entries: out.length ? [...state.entries, ...out] : state.entries,
	};
	if (releaseReason !== undefined) result.releaseReason = releaseReason;
	return result;
}

/** Fold events (any order; sorted by seq here) into a timeline. */
export function foldTimeline(
	events: readonly BeadEvent[],
	start: TimelineState = { entries: [] },
): TimelineState {
	return [...events].sort((a, b) => a.seq - b.seq).reduce(stepTimeline, start);
}

/**
 * Shape of `GET /api/beads/:id`. To stay live, fold the events after `seq`
 * onto `{ ...fold, entries: timeline }`.
 */
export type BeadDetail = {
	/** The bead now (bd serve), with its live lease. */
	bead: Bead;
	timeline: TimelineEntry[];
	/** Journal seq the timeline is at least as new as. */
	seq: number;
	/** The rest of the fold state, to continue folding. */
	fold: Omit<TimelineState, "entries">;
};

/** Body of `POST /api/beads`. */
export type NewWork = {
	title: string;
	description?: string;
	acceptance?: string;
	type?: string;
	priority?: 0 | 1 | 2 | 3 | 4;
	labels?: string[];
	/** Where the work runs: stored as labels the dispatcher reads. */
	env?: {
		repo: string;
		ref?: string;
		provider?: string;
		requires?: string[];
	};
};

/** One `GET /api/activity` page: journal events, newest first. */
export type ActivityPage = {
	events: BeadEvent[];
	/** The journal head when the page was read: follow `/api/events?since=head`. */
	head: number;
};
