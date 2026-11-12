import {
	type Bead,
	columnOf,
	ENV_TRIAGE_LABEL,
	envNameOf,
	FAILED_START_LABEL,
	NEEDS_HUMAN_LABEL,
	NOT_ACCEPTED_LABEL,
	queueOf,
	toOf,
} from "@mastermind/core";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Attachments, FILES_ASIDE } from "../files/attachments.tsx";
import { QueuePicker } from "../routing/queue-picker.tsx";
import { api } from "../work/api.ts";
import { useBeadDetail } from "../work/detail.ts";
import { ago, leaseView, useNow } from "../work/lease.ts";
import { TimelineRows } from "../work/timeline-view.tsx";
import { PriorityBadge, PrLink } from "./bead-card.tsx";
import { COLUMN_LABELS } from "./group.ts";
import { useLiveBoard } from "./live.ts";

function Section({
	title,
	aside,
	children,
}: {
	title: string;
	aside?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="border-foreground border-t pt-2">
			<h3 className="mb-1.5 flex items-baseline gap-2 font-semibold text-sm">
				{title}
				{aside && (
					<span className="font-normal text-muted-foreground">{aside}</span>
				)}
			</h3>
			{children}
		</section>
	);
}

/** Queue, holder, lease countdown and stage: the bead's state in one block. */
function StateLine({ bead }: { bead: Bead }) {
	const now = useNow();
	const lease = leaseView(bead.lease, now);
	const column = columnOf(bead);
	const stage =
		bead.status === "closed"
			? "done"
			: bead.assignee && bead.status === "in_progress"
				? "work"
				: queueOf(bead)
					? "waiting for a runner"
					: toOf(bead)
						? bead.labels.includes(NOT_ACCEPTED_LABEL)
							? `not accepted by ${toOf(bead)}: waiting (see notes)`
							: `offered to ${toOf(bead)}`
						: "waiting for routing";
	return (
		<dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-sm sm:grid-cols-[5.5rem_1fr_5.5rem_1fr]">
			<dt className="text-muted-foreground">Queue</dt>
			<dd>
				<QueuePicker beadId={bead.id} queue={queueOf(bead)} to={toOf(bead)} />
			</dd>
			<dt className="text-muted-foreground">Column</dt>
			<dd>{column ? COLUMN_LABELS[column] : "parked"}</dd>
			<dt className="text-muted-foreground">Holder</dt>
			<dd className="truncate">{bead.assignee ?? "—"}</dd>
			<dt className="text-muted-foreground">Lease</dt>
			<dd
				data-lease={lease.look}
				className={cn(
					"font-mono text-[13px] tabular-nums",
					lease.look === "live" && "text-live",
					(lease.look === "expiring" || lease.look === "expired") &&
						"text-signal",
				)}
			>
				{lease.look === "none"
					? "—"
					: lease.look === "expired"
						? `expired · beat ${lease.beatAgoS} s ago`
						: `■ ${lease.left} left · beat ${lease.beatAgoS} s ago`}
			</dd>
			<dt className="text-muted-foreground">Stage</dt>
			<dd>
				{bead.status !== "closed" &&
				bead.labels.includes(FAILED_START_LABEL) ? (
					<span data-failed-start className="text-signal">
						failed to start · see the notes
					</span>
				) : bead.status !== "closed" &&
					bead.labels.includes(NEEDS_HUMAN_LABEL) ? (
					<span data-needs-human className="text-signal">
						needs a human · see the notes
					</span>
				) : (
					stage
				)}
			</dd>
			<dt className="text-muted-foreground">Environment</dt>
			<dd className="truncate">
				{bead.labels.includes(ENV_TRIAGE_LABEL) ? (
					<span className="text-signal">
						{envNameOf(bead) ?? "none"} · not dispatched (see the notes)
					</span>
				) : (
					<span className="font-mono text-[13px]">
						{envNameOf(bead) ?? "—"}
					</span>
				)}
			</dd>
		</dl>
	);
}

function NoteBox({ beadId, onDone }: { beadId: string; onDone: () => void }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (e?: FormEvent) => {
		e?.preventDefault();
		if (!text.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.note(beadId, text.trim());
			setText("");
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-1.5">
			<label htmlFor="bead-note" className="sr-only">
				Note for the agent
			</label>
			<textarea
				id="bead-note"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
				}}
				rows={2}
				placeholder="Note for the agent (it gets it with the next dispatch)"
				className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={busy || !text.trim()}>
					Add note
				</Button>
				<span className="text-[11px] text-muted-foreground">⌘/Ctrl+Enter</span>
				{error && (
					<span role="alert" className="text-signal text-xs">
						{error}
					</span>
				)}
			</div>
		</form>
	);
}

export function BeadSheet() {
	const { beadId } = useParams({ from: "/board/$beadId" });
	const navigate = useNavigate();
	const board = useLiveBoard();
	const [reload, setReload] = useState(0);
	const live = useBeadDetail(beadId, board.onEvent, reload);
	const [acting, setActing] = useState(false);
	const [actError, setActError] = useState<string | null>(null);
	const now = useNow(5_000);

	const detail = live.status === "live" ? live.detail : null;
	// The board's copy carries the live lease (heartbeats); the detail is the fallback.
	const bead =
		board.beads.find((b) => b.id === beadId) ??
		(live.status === "live" ? (live.state.bead ?? detail?.bead) : undefined);
	const queue = bead ? queueOf(bead) : null;

	const act = async (fn: () => Promise<unknown>) => {
		setActing(true);
		setActError(null);
		try {
			await fn();
			setReload((n) => n + 1);
		} catch (err) {
			setActError(err instanceof Error ? err.message : String(err));
		} finally {
			setActing(false);
		}
	};

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) navigate({ to: "/board" });
			}}
		>
			<SheetContent className="gap-3 p-0 sm:max-w-[560px]">
				<nav className="flex items-baseline gap-1.5 border-b px-5 py-3 pr-12 text-[13px]">
					<Link to="/board" className="text-muted-foreground hover:underline">
						Board
					</Link>
					<span className="text-muted-foreground">/</span>
					<span className="font-mono">{beadId}</span>
					<span className="ml-auto text-[11px] text-muted-foreground">esc</span>
				</nav>
				<div className="flex flex-1 flex-col gap-4 px-5 pb-4">
					{bead ? (
						<header className="flex flex-col gap-1.5">
							<div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
								<PriorityBadge priority={bead.priority} />
								{queue && <Badge variant="outline">{queue}</Badge>}
								<span>
									{bead.type} · {bead.status.replace("_", " ")}
								</span>
							</div>
							<SheetTitle className="text-lg">{bead.title}</SheetTitle>
							<SheetDescription className="sr-only">
								Bead {beadId}: state, timeline and notes.
							</SheetDescription>
						</header>
					) : (
						<header>
							<SheetTitle>
								{live.status === "loading" ? "Loading…" : "Not found"}
							</SheetTitle>
							<SheetDescription>
								{live.status === "error"
									? live.notFound
										? `No bead ${beadId}.`
										: live.error
									: ""}
							</SheetDescription>
						</header>
					)}
					{bead && <StateLine bead={bead} />}
					{bead?.status === "closed" && bead.closeReason && (
						<Section title="Result">
							<p className="whitespace-pre-wrap text-sm">{bead.closeReason}</p>
						</Section>
					)}
					{bead?.output && (
						<Section title="Output">
							<p
								data-output
								className="flex flex-wrap items-center gap-x-2 text-sm"
							>
								<PrLink output={bead.output} className="text-sm" />
								{bead.output.branch && (
									<span className="font-mono text-xs">
										{bead.output.branch}
									</span>
								)}
								<span className="text-muted-foreground text-xs">
									{bead.output.commits} commit
									{bead.output.commits === 1 ? "" : "s"},{" "}
									{bead.output.filesChanged} file
									{bead.output.filesChanged === 1 ? "" : "s"} changed
								</span>
							</p>
						</Section>
					)}
					{bead && (
						<Section title="Files" aside={FILES_ASIDE}>
							<Attachments
								beadId={beadId}
								version={live.status === "live" ? live.state.entries.length : 0}
							/>
						</Section>
					)}
					{(detail?.bead.description ?? bead?.description) && (
						<Section title="Description">
							<p className="whitespace-pre-wrap text-sm">
								{detail?.bead.description ?? bead?.description}
							</p>
						</Section>
					)}
					{detail?.bead.acceptance && (
						<Section title="Acceptance">
							<p className="whitespace-pre-wrap text-sm">
								{detail.bead.acceptance}
							</p>
						</Section>
					)}
					{bead && bead.labels.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{bead.labels.map((l) => (
								<Badge key={l} variant="outline" className="font-mono">
									{l}
								</Badge>
							))}
						</div>
					)}
					<Section title="Timeline" aside="live">
						{live.status === "live" ? (
							live.state.entries.length ? (
								<TimelineRows entries={[...live.state.entries].reverse()} />
							) : (
								<p className="text-muted-foreground text-sm">
									No events in the journal yet.
								</p>
							)
						) : live.status === "loading" ? (
							<p className="text-muted-foreground text-sm">Loading…</p>
						) : (
							<p className="text-muted-foreground text-sm">{live.error}</p>
						)}
					</Section>
					{bead && <NoteBox beadId={beadId} onDone={() => {}} />}
				</div>
				{bead && (
					<footer className="sticky bottom-0 flex items-center gap-2 border-t bg-background px-5 py-3">
						{bead.status === "closed" ||
						bead.labels.includes(FAILED_START_LABEL) ||
						bead.labels.includes(NEEDS_HUMAN_LABEL) ? (
							<Button
								variant="outline"
								disabled={acting}
								onClick={() => act(() => api.reopen(beadId))}
							>
								Reopen
							</Button>
						) : (
							<Button
								variant="outline"
								disabled={acting}
								onClick={() => act(() => api.close(beadId))}
							>
								Close
							</Button>
						)}
						{actError && (
							<span role="alert" className="text-signal text-xs">
								{actError}
							</span>
						)}
						<span className="ml-auto text-[11px] text-muted-foreground">
							updated {ago(bead.updatedAt, now)} ago
						</span>
					</footer>
				)}
			</SheetContent>
		</Sheet>
	);
}
