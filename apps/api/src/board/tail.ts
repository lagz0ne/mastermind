import type { BeadEvent } from "@mastermind/core";

/** Anything that can page the journal: the work store, or a fake. */
export type JournalSource = {
	journalSince(seq: number): Promise<BeadEvent[]>;
};

export type TailOptions = {
	/** Resume cursor: yield records with seq greater than this. Default 0. */
	since?: number;
	/** Pause between polls once the journal is drained. Default 500 ms. */
	intervalMs?: number;
	/** Stops the tail. The generator then returns without throwing. */
	signal?: AbortSignal;
};

/**
 * Follows the events journal: yields every record after `since`, in seq order,
 * then polls for new ones. Pages are read back to back while the journal has
 * a backlog, and it sleeps only once a read comes back empty.
 *
 * The journal is per replica, so a cursor only means something against the
 * replica it came from.
 */
export async function* tailJournal(
	source: JournalSource,
	options: TailOptions = {},
): AsyncGenerator<BeadEvent, void, undefined> {
	const { intervalMs = 500, signal } = options;
	let cursor = options.since ?? 0;
	while (!signal?.aborted) {
		const page = await source.journalSince(cursor);
		const fresh = page
			.filter((e) => e.seq > cursor)
			.sort((a, b) => a.seq - b.seq);
		for (const event of fresh) {
			if (signal?.aborted) return;
			cursor = event.seq;
			yield event;
		}
		if (fresh.length === 0) await sleep(intervalMs, signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}
