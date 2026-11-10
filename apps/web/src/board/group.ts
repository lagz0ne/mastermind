import {
	type Bead,
	BOARD_COLUMNS,
	type BoardColumn,
	columnOf,
	queueOf,
} from "@mastermind/core";

export type BoardModel = Record<BoardColumn, Bead[]>;

export const COLUMN_LABELS: Record<BoardColumn, string> = {
	ready: "Ready",
	in_progress: "In progress",
	blocked: "Blocked",
	done: "Done",
};

/**
 * Put each bead in its kanban column (beads columnOf parks are left out).
 * Within a column: most urgent first, then most recently updated.
 */
export function groupByColumn(beads: readonly Bead[]): BoardModel {
	const board = Object.fromEntries(
		BOARD_COLUMNS.map((c) => [c, [] as Bead[]]),
	) as BoardModel;
	for (const bead of beads) {
		const column = columnOf(bead);
		if (column) board[column].push(bead);
	}
	for (const column of BOARD_COLUMNS) {
		board[column].sort(
			(a, b) =>
				a.priority - b.priority ||
				Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
		);
	}
	return board;
}

/** Board filter: all beads, the unrouted ones, or one queue. */
export type QueueFilter =
	| { kind: "all" }
	| { kind: "unrouted" }
	| { kind: "queue"; name: string };

export const ALL: QueueFilter = { kind: "all" };

export function filterByQueue(
	beads: readonly Bead[],
	filter: QueueFilter,
): readonly Bead[] {
	if (filter.kind === "all") return beads;
	return beads.filter((b) =>
		filter.kind === "unrouted"
			? queueOf(b) === null
			: queueOf(b) === filter.name,
	);
}

/** Beads per queue (sorted by name) and the unrouted count, for the filter bar. */
export function queueCounts(beads: readonly Bead[]): {
	queues: { name: string; count: number }[];
	unrouted: number;
} {
	const counts = new Map<string, number>();
	let unrouted = 0;
	for (const b of beads) {
		if (!columnOf(b)) continue;
		const q = queueOf(b);
		if (q === null) unrouted++;
		else counts.set(q, (counts.get(q) ?? 0) + 1);
	}
	return {
		queues: [...counts]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		unrouted,
	};
}
