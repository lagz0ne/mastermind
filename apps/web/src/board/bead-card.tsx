import { type Bead, queueOf } from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type LeaseLook, leaseView, useNow } from "../work/lease.ts";

export function PriorityBadge({ priority }: Pick<Bead, "priority">) {
	return (
		<Badge variant={priority === 0 ? "signal" : "outline"}>P{priority}</Badge>
	);
}

const LEASE_TEXT: Record<Exclude<LeaseLook, "none">, string> = {
	live: "text-live",
	expiring: "text-signal",
	expired: "text-signal line-through",
};

/** ■ m:ss left (live, expiring) or expired; ticks every second. */
export function LeaseMark({ lease }: Pick<Bead, "lease">) {
	const now = useNow();
	const view = leaseView(lease, now);
	if (view.look === "none") return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-lease={view.look}
					className={cn(
						"inline-flex items-center gap-1 font-mono text-[11px] tabular-nums",
						LEASE_TEXT[view.look],
					)}
				>
					<span aria-hidden className="size-1.5 bg-current" />
					{view.look === "expired" ? "expired" : view.left}
					<span className="sr-only"> lease {view.look}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>
				lease {view.look} · {view.look === "expired" ? "expired" : "expires"}{" "}
				{new Date(lease?.expiresAt ?? 0).toLocaleTimeString()} · beat{" "}
				{view.beatAgoS} s ago
			</TooltipContent>
		</Tooltip>
	);
}

export function BeadCard({ bead }: { bead: Bead }) {
	const queue = queueOf(bead);
	return (
		<Link
			to="/board/$beadId"
			params={{ beadId: bead.id }}
			className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Card className="transition-colors hover:border-foreground/40">
				<CardHeader className="text-[11px] text-muted-foreground">
					<span className="font-mono">{bead.id}</span>
					<PriorityBadge priority={bead.priority} />
					{queue ? (
						<span className="ml-auto">{queue}</span>
					) : (
						<span
							data-unrouted
							title="No rule matched: nobody takes this bead until it gets a queue"
							className="ml-auto rounded-[var(--radius)] border border-dashed px-1"
						>
							unrouted
						</span>
					)}
				</CardHeader>
				<CardTitle>{bead.title}</CardTitle>
				{(bead.assignee || bead.lease) && (
					<CardFooter className="text-[11px] text-muted-foreground">
						{bead.assignee && <span className="truncate">{bead.assignee}</span>}
						<span className="ml-auto">
							<LeaseMark lease={bead.lease} />
						</span>
					</CardFooter>
				)}
			</Card>
		</Link>
	);
}
