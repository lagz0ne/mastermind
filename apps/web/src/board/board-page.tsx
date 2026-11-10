import { BOARD_COLUMNS } from "@mastermind/core";
import { Outlet } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { BeadCard } from "./bead-card.tsx";
import {
	ALL,
	COLUMN_LABELS,
	filterByQueue,
	groupByColumn,
	type QueueFilter,
	queueCounts,
} from "./group.ts";
import {
	type LiveBoard,
	LiveBoardContext,
	useLiveBoard,
	useLiveBoardSource,
} from "./live.ts";

export function useBoardBeads() {
	return useLiveBoard().beads;
}

/** One muted line while the board is not live; nothing when it is. */
function boardNotice(board: LiveBoard): string | null {
	switch (board.status) {
		case "loading":
			return "Loading board…";
		case "reconnecting":
			return "Reconnecting to live updates…";
		case "offline":
			return `Board offline: ${board.error ?? "api unreachable"}`;
		default:
			return null;
	}
}

const same = (a: QueueFilter, b: QueueFilter) =>
	a.kind === b.kind &&
	(a.kind !== "queue" || (b.kind === "queue" && a.name === b.name));

/** All · unrouted · one chip per queue on the board, with counts. */
function QueueBar({
	beads,
	filter,
	onChange,
}: {
	beads: LiveBoard["beads"];
	filter: QueueFilter;
	onChange: (f: QueueFilter) => void;
}) {
	const { queues, unrouted } = useMemo(() => queueCounts(beads), [beads]);
	const chips: { f: QueueFilter; label: string; count?: number }[] = [
		{ f: ALL, label: "All queues" },
		...queues.map((q) => ({
			f: { kind: "queue", name: q.name } as QueueFilter,
			label: q.name,
			count: q.count,
		})),
		{ f: { kind: "unrouted" }, label: "unrouted", count: unrouted },
	];
	return (
		<nav
			aria-label="Filter by queue"
			className="flex gap-1 overflow-x-auto px-4 pt-2 text-[12px]"
		>
			{chips.map(({ f, label, count }) => (
				<button
					key={label}
					type="button"
					aria-pressed={same(f, filter)}
					onClick={() => onChange(f)}
					className={cn(
						"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius)] border px-2",
						same(f, filter)
							? "border-foreground bg-foreground text-background"
							: "text-muted-foreground hover:text-foreground",
						f.kind === "unrouted" && "border-dashed",
					)}
				>
					{label}
					{count !== undefined && (
						<span className="tabular-nums opacity-70">{count}</span>
					)}
				</button>
			))}
		</nav>
	);
}

export function BoardPage() {
	const live = useLiveBoardSource();
	const [filter, setFilter] = useState<QueueFilter>(ALL);
	const board = useMemo(
		() => groupByColumn(filterByQueue(live.beads, filter)),
		[live.beads, filter],
	);
	const notice = boardNotice(live);

	return (
		<LiveBoardContext.Provider value={live}>
			<div className="flex h-full flex-col">
				{notice && (
					<p
						role="status"
						className="px-4 pt-2 font-mono text-[11px] text-muted-foreground"
					>
						{notice}
					</p>
				)}
				<QueueBar beads={live.beads} filter={filter} onChange={setFilter} />
				<div className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 py-3 md:grid md:snap-none md:grid-cols-4 md:overflow-x-visible">
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
			</div>
			<Outlet />
		</LiveBoardContext.Provider>
	);
}
