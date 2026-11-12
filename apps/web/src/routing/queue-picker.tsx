// "Move to queue" and "Send to" for one bead: a manual queue label or to:
// label wins over the rules. Frame SC7_aqhn_q (send to).
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
	ADDRESS,
	getRouting,
	moveToQueue,
	sendTo,
	UNROUTED_REASON,
} from "./routing.ts";

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
	to,
	className,
}: {
	beadId: string;
	queue: string | null;
	/** The bead's direct address (label to:<address>); undefined hides "Send to". */
	to?: string | null;
	className?: string;
}) {
	const names = useQueueNames();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const options = [...new Set([...(names ?? []), ...(queue ? [queue] : [])])];
	const move = (next: string | null) => {
		setBusy(true);
		setError(null);
		moveToQueue(beadId, next)
			.catch((err) =>
				setError(err instanceof Error ? err.message : String(err)),
			)
			.finally(() => setBusy(false));
	};
	// The only queue: one click puts the bead there.
	const only = !queue && names?.length === 1 ? names[0] : undefined;
	return (
		<span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
			<select
				aria-label="Move to queue"
				title="Move to queue: a manual queue wins over the rules"
				value={queue ?? UNROUTED}
				disabled={busy || names === null}
				onChange={(e) =>
					move(e.target.value === UNROUTED ? null : e.target.value)
				}
				className="h-6 rounded-[var(--radius)] border bg-card px-1 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<option value={UNROUTED}>unrouted (rules decide)</option>
				{options.map((n) => (
					<option key={n} value={n}>
						{n}
					</option>
				))}
			</select>
			{only && (
				<button
					type="button"
					disabled={busy}
					onClick={() => move(only)}
					className="h-6 rounded-[var(--radius)] border px-1.5 font-medium text-xs hover:bg-muted disabled:opacity-50"
				>
					Move to {only}
				</button>
			)}
			{!queue && !to && (
				<span data-unrouted-reason className="text-muted-foreground text-xs">
					{UNROUTED_REASON}
				</span>
			)}
			{error && <span className="text-destructive text-xs">{error}</span>}
			{to !== undefined && <SendTo beadId={beadId} to={to} />}
		</span>
	);
}

/** Send the bead to one address (`<account>` or `<account>/<runner>`). */
export function SendTo({ beadId, to }: { beadId: string; to: string | null }) {
	const [text, setText] = useState(to ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setText(to ?? ""), [to]);
	const send = (next: string | null) => {
		setBusy(true);
		setError(null);
		sendTo(beadId, next)
			.catch((err) =>
				setError(err instanceof Error ? err.message : String(err)),
			)
			.finally(() => setBusy(false));
	};
	const value = text.trim();
	const valid = ADDRESS.test(value);
	const btn =
		"h-6 rounded-[var(--radius)] border px-1.5 font-medium text-xs hover:bg-muted disabled:opacity-50";
	return (
		<form
			data-doop-id="sheet-send-to"
			className="flex w-full flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (valid && value !== to) send(value);
			}}
		>
			<span className="text-muted-foreground text-xs">Send to</span>
			<input
				aria-label="Send to"
				placeholder="account/runner"
				title="<account> or <account>/<runner>: offered only there; wins over the rules"
				value={text}
				disabled={busy}
				onChange={(e) => setText(e.target.value)}
				className={cn(
					"h-6 w-36 rounded-[var(--radius)] border bg-card px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring",
					value !== "" && !valid && "border-destructive",
				)}
			/>
			<button
				type="submit"
				disabled={busy || !valid || value === to}
				className={btn}
			>
				Send
			</button>
			{to && (
				<button
					type="button"
					disabled={busy}
					onClick={() => send(null)}
					className={btn}
				>
					Clear
				</button>
			)}
			{error && <span className="text-destructive text-xs">{error}</span>}
		</form>
	);
}
