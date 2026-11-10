import {
	type Bead,
	BOARD_COLUMNS,
	type BoardColumn,
	columnOf,
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
