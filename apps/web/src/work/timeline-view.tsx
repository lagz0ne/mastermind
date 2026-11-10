import type { TimelineEntry, TimelineKind } from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export const KIND_LABELS: Record<TimelineKind, string> = {
	created: "created",
	routed: "routed",
	claimed: "claimed",
	report: "report",
	note: "note",
	released: "released",
	completed: "completed",
	closed: "closed",
	reopened: "reopened",
	updated: "updated",
};

/** One line that says what happened, without the kind. */
export function entryDetail(e: TimelineEntry): string {
	switch (e.kind) {
		case "created":
			return e.actor;
		case "routed":
			return `${e.actor} · queue:${e.queue ?? ""}`;
		case "claimed":
			return `${e.holder ?? e.actor}${e.lease ? ` · lease to ${time(e.lease.expiresAt)}` : ""}`;
		case "released":
			return `${e.holder ?? e.actor} · ${e.text ?? "lease expired"}`;
		case "report":
		case "note":
			return `${e.actor} · ${e.text ?? ""}`;
		case "completed":
		case "closed":
			return `${e.actor}${e.text ? ` · ${e.text}` : ""}`;
		default:
			return e.actor;
	}
}

export function time(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

const STRONG: ReadonlySet<TimelineKind> = new Set([
	"claimed",
	"completed",
	"closed",
	"released",
]);

/** Rows: seq · time · kind · detail (and the bead, in the activity feed). */
export function TimelineRows({
	entries,
	withBead = false,
}: {
	entries: readonly (TimelineEntry & { title?: string })[];
	withBead?: boolean;
}) {
	return (
		<ol className="flex flex-col text-[13px]">
			{entries.map((e) => (
				<li
					key={`${e.seq}-${e.kind}-${e.at}-${e.actor}`}
					className={cn(
						"grid items-baseline gap-x-3 border-b border-dashed py-1 last:border-b-0",
						withBead
							? "grid-cols-[4.5rem_5.5rem_6rem_1fr]"
							: "grid-cols-[3.5rem_4.5rem_5.5rem_1fr]",
					)}
				>
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{withBead ? (
							<Link
								to="/board/$beadId"
								params={{ beadId: e.beadId }}
								className="underline-offset-2 hover:underline"
							>
								{e.beadId}
							</Link>
						) : e.seq ? (
							e.seq
						) : (
							"—"
						)}
					</span>
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{time(e.at)}
					</span>
					<span
						className={cn(
							STRONG.has(e.kind) && "font-semibold",
							e.kind === "released" && "text-signal",
						)}
					>
						{KIND_LABELS[e.kind]}
					</span>
					<span
						className={cn(
							"min-w-0 break-words",
							e.kind === "report" || e.kind === "note"
								? "whitespace-pre-wrap"
								: "truncate",
						)}
					>
						{withBead && e.title && (
							<span className="text-muted-foreground">{e.title} · </span>
						)}
						{entryDetail(e)}
					</span>
				</li>
			))}
		</ol>
	);
}
