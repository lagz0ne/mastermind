import {
	type BeadEvent,
	queueOf,
	stepTimeline,
	type TimelineEntry,
	type TimelineState,
} from "@mastermind/core";

/** A feed row: a timeline entry with what the filters and the row need. */
export type FeedRow = TimelineEntry & {
	title: string;
	/** The bead's queue at that moment. */
	onQueue: string | null;
	/** Accounts involved: the actor's and the holder's (`<account>/<agent>` → account). */
	accounts: string[];
};

export type Feed = {
	/** Newest first. */
	rows: FeedRow[];
	/** Fold state per bead, to keep folding live events. */
	folds: Map<string, TimelineState>;
	/** Highest seq folded. */
	seq: number;
};

export const MAX_ROWS = 1_000;

export const emptyFeed = (): Feed => ({ rows: [], folds: new Map(), seq: 0 });

export function accountOf(actor: string): string {
	return actor.split("/")[0] ?? actor;
}

/** Fold events (any order) into the feed; events at or below feed.seq are skipped. */
export function foldFeed(feed: Feed, events: readonly BeadEvent[]): Feed {
	const folds = new Map(feed.folds);
	const fresh: FeedRow[] = [];
	let seq = feed.seq;
	for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
		if (event.seq <= seq) continue;
		seq = event.seq;
		const before = folds.get(event.beadId) ?? { entries: [] };
		const after = stepTimeline({ ...before, entries: [] }, event);
		folds.set(event.beadId, { ...after, entries: [] });
		const bead = after.bead ?? before.bead;
		for (const entry of after.entries) {
			const accounts = new Set([accountOf(entry.actor)]);
			if (entry.holder) accounts.add(accountOf(entry.holder));
			fresh.push({
				...entry,
				title: bead?.title ?? "",
				onQueue: bead ? queueOf(bead) : null,
				accounts: [...accounts],
			});
		}
	}
	return {
		rows: [...fresh.reverse(), ...feed.rows].slice(0, MAX_ROWS),
		folds,
		seq,
	};
}

export type FeedFilter = { queue: string; account: string };

export function filterRows(
	rows: readonly FeedRow[],
	filter: FeedFilter,
): FeedRow[] {
	return rows.filter(
		(r) =>
			(!filter.queue || r.onQueue === filter.queue) &&
			(!filter.account || r.accounts.includes(filter.account)),
	);
}

/** Choices for the filters, sorted. */
export function choices(rows: readonly FeedRow[]) {
	const queues = new Set<string>();
	const accounts = new Set<string>();
	for (const r of rows) {
		if (r.onQueue) queues.add(r.onQueue);
		for (const a of r.accounts) accounts.add(a);
	}
	return { queues: [...queues].sort(), accounts: [...accounts].sort() };
}
