import {
	type Bead,
	ENV_TRIAGE_LABEL,
	envNameOf,
	FAILED_START_LABEL,
	NEEDS_HUMAN_LABEL,
	queueOf,
} from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UNROUTED_REASON } from "../routing/routing.ts";
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

/** The bead's environment; red when the dispatcher holds it back. */
export function EnvMark({ bead }: { bead: Pick<Bead, "labels"> }) {
	const name = envNameOf(bead);
	const held = bead.labels.includes(ENV_TRIAGE_LABEL);
	if (!name && !held) return null;
	return (
		<span
			data-env={name ?? ""}
			data-env-held={held || undefined}
			title={
				held
					? "Not dispatched: the environment does not resolve (see the notes)"
					: `Environment ${name}`
			}
			className={cn("truncate font-mono", held && "text-signal line-through")}
		>
			{name ?? "no env"}
		</span>
	);
}

/** The dispatcher holds the bead back: its agent failed to start 3 times. */
export function FailedStartMark({ bead }: { bead: Pick<Bead, "labels"> }) {
	if (!bead.labels.includes(FAILED_START_LABEL)) return null;
	return (
		<span
			data-failed-start
			title="Not dispatched: the agent failed to start 3 times (the reason is in the notes). Reopen to try again."
			className="text-signal"
		>
			failed to start
		</span>
	);
}

/** The dispatcher holds the bead back: 3 attempts ended without a result. */
export function NeedsHumanMark({ bead }: { bead: Pick<Bead, "labels"> }) {
	if (!bead.labels.includes(NEEDS_HUMAN_LABEL)) return null;
	return (
		<span
			data-needs-human
			title="Not dispatched: it was released or its lease expired too many times (the reasons are in the notes). Reopen to try again."
			className="text-signal"
		>
			needs a human
		</span>
	);
}

/** `PR #7` for a GitHub-style pull request URL; else `PR`. */
export function prLabel(prUrl: string): string {
	const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
	return n ? `PR #${n}` : "PR";
}

/** The pull request the work opened (box output); opens in a new tab. */
export function PrLink({
	output,
	className,
}: Pick<Bead, "output"> & { className?: string }) {
	if (!output?.prUrl) return null;
	return (
		<a
			href={output.prUrl}
			target="_blank"
			rel="noreferrer"
			data-pr-link
			title={`Pull request: ${output.prUrl}`}
			className={cn(
				"font-mono text-[11px] text-foreground underline underline-offset-2 hover:text-live",
				className,
			)}
		>
			{prLabel(output.prUrl)}
		</a>
	);
}

export function BeadCard({ bead }: { bead: Bead }) {
	const queue = queueOf(bead);
	const env = envNameOf(bead) || bead.labels.includes(ENV_TRIAGE_LABEL);
	const failed =
		bead.labels.includes(FAILED_START_LABEL) ||
		bead.labels.includes(NEEDS_HUMAN_LABEL);
	const pr = bead.output?.prUrl;
	// The PR link sits over the card, not in it: a link in a link is not valid
	// HTML. A hidden copy in the footer keeps its place.
	return (
		<div className="relative">
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
								title={`Unrouted: ${UNROUTED_REASON}. Nobody takes this bead until it has a queue.`}
								className="ml-auto rounded-[var(--radius)] border border-dashed px-1"
							>
								unrouted
							</span>
						)}
					</CardHeader>
					<CardTitle>{bead.title}</CardTitle>
					{!queue && (
						<p
							data-unrouted-reason
							className="text-[11px] text-muted-foreground"
						>
							{UNROUTED_REASON}
						</p>
					)}
					{(bead.assignee || bead.lease || env || failed || pr) && (
						<CardFooter className="text-[11px] text-muted-foreground">
							<EnvMark bead={bead} />
							<FailedStartMark bead={bead} />
							<NeedsHumanMark bead={bead} />
							{bead.assignee && (
								<span className="truncate">{bead.assignee}</span>
							)}
							<span className="ml-auto flex items-center gap-1.5">
								<LeaseMark lease={bead.lease} />
								{pr && (
									<span aria-hidden className="invisible font-mono">
										{prLabel(pr)}
									</span>
								)}
							</span>
						</CardFooter>
					)}
				</Card>
			</Link>
			<PrLink output={bead.output} className="absolute right-2 bottom-2" />
		</div>
	);
}
