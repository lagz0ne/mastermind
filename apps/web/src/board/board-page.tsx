import { BOARD_COLUMNS } from "@mastermind/core";
import { Outlet } from "@tanstack/react-router";
import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BeadCard } from "./bead-card.tsx";
import { fixtureBeads } from "./fixture.ts";
import { COLUMN_LABELS, groupByColumn } from "./group.ts";

export function useBoardBeads() {
	return useMemo(() => fixtureBeads(), []);
}

export function BoardPage() {
	const beads = useBoardBeads();
	const board = useMemo(() => groupByColumn(beads), [beads]);

	return (
		<>
			<div className="flex h-full snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 py-3 md:grid md:snap-none md:grid-cols-4 md:overflow-x-visible">
				{BOARD_COLUMNS.map((column) => (
					<section
						key={column}
						aria-labelledby={`col-${column}`}
						className="flex min-h-0 w-[85%] shrink-0 snap-start flex-col md:w-auto"
					>
						<h2
							id={`col-${column}`}
							className="flex items-baseline gap-2 border-foreground border-t-2 pt-1.5 pb-2 font-bold text-sm"
						>
							{COLUMN_LABELS[column]}
							<span className="font-normal text-muted-foreground tabular-nums">
								{board[column].length}
							</span>
						</h2>
						<ScrollArea className="min-h-0 flex-1">
							<ul className="flex flex-col gap-2 pb-2">
								{board[column].map((bead) => (
									<li key={bead.id}>
										<BeadCard bead={bead} />
									</li>
								))}
							</ul>
						</ScrollArea>
					</section>
				))}
			</div>
			<Outlet />
		</>
	);
}
