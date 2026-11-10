import type { Bead, BeadEvent, BoardSnapshot } from "@mastermind/core";
import { createContext, useContext, useEffect, useState } from "react";

/** "loading" until the snapshot arrives; "offline" when the api cannot serve it. */
export type BoardStatus = "loading" | "live" | "reconnecting" | "offline";

export type LiveBoard = {
	beads: Bead[];
	status: BoardStatus;
	/** Journal seq the board reflects. */
	seq: number;
	/** Why the board is offline (the api's error). */
	error?: string;
};

export const emptyBoard: LiveBoard = { beads: [], status: "loading", seq: 0 };

/**
 * Apply one journal event: the event carries the bead after the mutation,
 * so applying it twice is harmless. No bead (a delete) removes it.
 */
export function applyEvent(
	beads: ReadonlyMap<string, Bead>,
	event: BeadEvent,
): Map<string, Bead> {
	const next = new Map(beads);
	if (event.bead && event.op !== "delete") next.set(event.beadId, event.bead);
	else next.delete(event.beadId);
	return next;
}

async function loadSnapshot(): Promise<BoardSnapshot> {
	const res = await fetch("/api/board");
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(body?.error ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as BoardSnapshot;
}

/**
 * GET /api/board once, then follow GET /api/events from its seq. EventSource
 * reconnects by itself and resumes with Last-Event-ID.
 */
export function useLiveBoardSource(): LiveBoard {
	const [board, setBoard] = useState<LiveBoard>(emptyBoard);

	useEffect(() => {
		let source: EventSource | null = null;
		let cancelled = false;
		let beads = new Map<string, Bead>();

		loadSnapshot()
			.then((snapshot) => {
				if (cancelled) return;
				beads = new Map(snapshot.beads.map((b) => [b.id, b]));
				let seq = snapshot.seq;
				setBoard({ beads: [...beads.values()], status: "live", seq });
				source = new EventSource(`/api/events?since=${snapshot.seq}`);
				source.addEventListener("bead", (message) => {
					const event = JSON.parse(message.data) as BeadEvent;
					if (event.seq <= seq) return;
					seq = event.seq;
					beads = applyEvent(beads, event);
					setBoard({ beads: [...beads.values()], status: "live", seq });
				});
				source.addEventListener("open", () =>
					setBoard((b) => ({ ...b, status: "live" })),
				);
				source.addEventListener("error", () =>
					setBoard((b) => ({ ...b, status: "reconnecting" })),
				);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setBoard({
					beads: [],
					status: "offline",
					seq: 0,
					error: error instanceof Error ? error.message : String(error),
				});
			});

		return () => {
			cancelled = true;
			source?.close();
		};
	}, []);

	return board;
}

export const LiveBoardContext = createContext<LiveBoard>(emptyBoard);

export function useLiveBoard(): LiveBoard {
	return useContext(LiveBoardContext);
}
