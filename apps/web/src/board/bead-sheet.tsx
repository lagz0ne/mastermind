import { columnOf, queueOf } from "@mastermind/core";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { LeaseMark, PriorityBadge } from "./bead-card.tsx";
import { useBoardBeads } from "./board-page.tsx";
import { COLUMN_LABELS } from "./group.ts";

export function BeadSheet() {
	const { beadId } = useParams({ from: "/board/$beadId" });
	const navigate = useNavigate();
	const bead = useBoardBeads().find((b) => b.id === beadId);
	const column = bead ? columnOf(bead) : null;

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) navigate({ to: "/board" });
			}}
		>
			<SheetContent>
				<SheetHeader>
					<span className="font-mono text-muted-foreground text-xs">
						{beadId}
					</span>
					<SheetTitle>{bead?.title ?? "Not found"}</SheetTitle>
					<SheetDescription>
						{bead?.description ??
							(bead ? "No description." : `No bead ${beadId} on the board.`)}
					</SheetDescription>
				</SheetHeader>
				{bead && (
					<dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Column</dt>
						<dd>{column ? COLUMN_LABELS[column] : "parked"}</dd>
						<dt className="text-muted-foreground">Priority</dt>
						<dd>
							<PriorityBadge priority={bead.priority} />
						</dd>
						<dt className="text-muted-foreground">Queue</dt>
						<dd>{queueOf(bead) ?? "unrouted"}</dd>
						<dt className="text-muted-foreground">Assignee</dt>
						<dd>{bead.assignee ?? "—"}</dd>
						<dt className="text-muted-foreground">Lease</dt>
						<dd>{bead.lease ? <LeaseMark lease={bead.lease} /> : "—"}</dd>
						<dt className="text-muted-foreground">Type</dt>
						<dd>{bead.type}</dd>
					</dl>
				)}
			</SheetContent>
		</Sheet>
	);
}
