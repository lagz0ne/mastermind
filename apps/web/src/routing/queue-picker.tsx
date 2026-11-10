// "Move to queue" for one bead: a manual queue label wins over the rules.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { getRouting, moveToQueue } from "./routing.ts";

let cached: Promise<string[]> | null = null;

/** Queue names from GET /api/routing, fetched once per page load. */
function useQueueNames(): string[] | null {
	const [names, setNames] = useState<string[] | null>(null);
	useEffect(() => {
		cached ??= getRouting()
			.then((r) => r.queues.map((q) => q.name))
			.catch(() => {
				cached = null;
				return [];
			});
		let alive = true;
		cached.then((n) => alive && setNames(n));
		return () => {
			alive = false;
		};
	}, []);
	return names;
}

const UNROUTED = "";

export function QueuePicker({
	beadId,
	queue,
	className,
}: {
	beadId: string;
	queue: string | null;
	className?: string;
}) {
	const names = useQueueNames();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const options = [...new Set([...(names ?? []), ...(queue ? [queue] : [])])];
	return (
		<span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
			<select
				aria-label="Move to queue"
				title="Move to queue: a manual queue wins over the rules"
				value={queue ?? UNROUTED}
				disabled={busy || names === null}
				onChange={(e) => {
					const next = e.target.value === UNROUTED ? null : e.target.value;
					setBusy(true);
					setError(null);
					moveToQueue(beadId, next)
						.catch((err) =>
							setError(err instanceof Error ? err.message : String(err)),
						)
						.finally(() => setBusy(false));
				}}
				className="h-6 rounded-[var(--radius)] border bg-card px-1 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<option value={UNROUTED}>unrouted (rules decide)</option>
				{options.map((n) => (
					<option key={n} value={n}>
						{n}
					</option>
				))}
			</select>
			{error && <span className="text-destructive text-xs">{error}</span>}
		</span>
	);
}
