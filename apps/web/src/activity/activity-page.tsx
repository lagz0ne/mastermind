import type { BeadEvent } from "@mastermind/core";
import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "../work/api.ts";
import { TimelineRows } from "../work/timeline-view.tsx";
import {
	choices,
	emptyFeed,
	type Feed,
	type FeedFilter,
	filterRows,
	foldFeed,
} from "./feed.ts";

type Status = "loading" | "live" | "reconnecting" | "offline";

/** The last 300 journal events, then live from /api/events. */
function useLiveFeed(): { feed: Feed; status: Status; error?: string } {
	const [state, setState] = useState<{
		feed: Feed;
		status: Status;
		error?: string;
	}>({ feed: emptyFeed(), status: "loading" });

	useEffect(() => {
		let source: EventSource | null = null;
		let cancelled = false;
		let feed = emptyFeed();
		api
			.activity(300)
			.then((page) => {
				if (cancelled) return;
				feed = foldFeed(feed, page.events);
				feed = { ...feed, seq: Math.max(feed.seq, page.head) };
				setState({ feed, status: "live" });
				source = new EventSource(`/api/events?since=${page.head}`);
				source.addEventListener("bead", (message) => {
					feed = foldFeed(feed, [JSON.parse(message.data) as BeadEvent]);
					setState({ feed, status: "live" });
				});
				source.addEventListener("open", () =>
					setState((s) => ({ ...s, status: "live" })),
				);
				source.addEventListener("error", () =>
					setState((s) => ({ ...s, status: "reconnecting" })),
				);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setState({
					feed,
					status: "offline",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
			source?.close();
		};
	}, []);
	return state;
}

const select =
	"rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ActivityPage() {
	const { feed, status, error } = useLiveFeed();
	const [filter, setFilter] = useState<FeedFilter>({ queue: "", account: "" });
	const options = useMemo(() => choices(feed.rows), [feed.rows]);
	const rows = useMemo(
		() => filterRows(feed.rows, filter),
		[feed.rows, filter],
	);

	return (
		<div className="flex h-full flex-col px-4 py-3">
			<div className="flex flex-wrap items-center gap-2 pb-2">
				<h1 className="font-bold text-sm">Activity</h1>
				<span className="font-mono text-[11px] text-muted-foreground">
					{status === "live"
						? "live"
						: status === "offline"
							? `offline: ${error ?? "api unreachable"}`
							: status === "loading"
								? "loading…"
								: "reconnecting…"}
				</span>
				<label className="ml-auto flex items-center gap-1 text-[12px] text-muted-foreground">
					Queue
					<select
						className={select}
						value={filter.queue}
						onChange={(e) =>
							setFilter((f) => ({ ...f, queue: e.target.value }))
						}
					>
						<option value="">all</option>
						{options.queues.map((q) => (
							<option key={q} value={q}>
								{q}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-1 text-[12px] text-muted-foreground">
					Account
					<select
						className={select}
						value={filter.account}
						onChange={(e) =>
							setFilter((f) => ({ ...f, account: e.target.value }))
						}
					>
						<option value="">all</option>
						{options.accounts.map((a) => (
							<option key={a} value={a}>
								{a}
							</option>
						))}
					</select>
				</label>
			</div>
			<ScrollArea className="min-h-0 flex-1 border-foreground border-t pt-1">
				{rows.length ? (
					<TimelineRows entries={rows} withBead />
				) : (
					<p className="py-2 text-muted-foreground text-sm">
						{status === "loading" ? "Loading…" : "No activity."}
					</p>
				)}
			</ScrollArea>
		</div>
	);
}
