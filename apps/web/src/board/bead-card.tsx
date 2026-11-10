import { type Bead, leaseState, queueOf } from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function PriorityBadge({ priority }: Pick<Bead, "priority">) {
	return (
		<Badge variant={priority === 0 ? "signal" : "outline"}>P{priority}</Badge>
	);
}

export function LeaseMark({ lease }: Pick<Bead, "lease">) {
	const state = leaseState(lease);
	if (state === "none") return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"inline-flex items-center gap-1 text-[11px]",
						state === "live" ? "text-live" : "text-signal",
					)}
				>
					<span aria-hidden className="size-1.5 rounded-full bg-current" />
					{state === "live" ? "lease live" : "lease expired"}
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{state === "live" ? "expires" : "expired"}{" "}
				{new Date(lease?.expiresAt ?? 0).toLocaleTimeString()}
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
					<span className="ml-auto">{queue ?? "unrouted"}</span>
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
