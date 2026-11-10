import {
	type BeadDetail,
	type BeadEvent,
	stepTimeline,
	type TimelineState,
} from "@mastermind/core";
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export type LiveDetail =
	| { status: "loading" }
	| { status: "error"; error: string; notFound: boolean }
	| { status: "live"; detail: BeadDetail; state: TimelineState; seq: number };

/** Fold the live events after the detail's seq onto its timeline. */
export function foldAfter(
	detail: BeadDetail,
	events: readonly BeadEvent[],
): { state: TimelineState; seq: number } {
	let state: TimelineState = { ...detail.fold, entries: detail.timeline };
	let seq = detail.seq;
	for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
		if (event.seq <= seq || event.beadId !== detail.bead.id) continue;
		state = stepTimeline(state, event);
		seq = event.seq;
	}
	return { state, seq };
}

/**
 * GET /api/beads/:id, then keep its timeline live from the board's event
 * stream. Events that arrive while the detail loads are held and folded after.
 */
export function useBeadDetail(
	id: string,
	onEvent: (listener: (event: BeadEvent) => void) => () => void,
	/** Bump to load again (after a write that the stream will not echo first). */
	reload = 0,
): LiveDetail {
	const [live, setLive] = useState<LiveDetail>({ status: "loading" });
	useEffect(() => {
		let cancelled = false;
		let held: BeadEvent[] = [];
		let current: Extract<LiveDetail, { status: "live" }> | null = null;
		const off = onEvent((event) => {
			if (event.beadId !== id) return;
			if (!current) {
				held.push(event);
				return;
			}
			const next = foldAfter(
				{
					...current.detail,
					fold: current.state,
					timeline: current.state.entries,
					seq: current.seq,
				},
				[event],
			);
			current = { ...current, ...next };
			setLive(current);
		});
		void reload;
		api
			.detail(id)
			.then((detail) => {
				if (cancelled) return;
				current = { status: "live", detail, ...foldAfter(detail, held) };
				held = [];
				setLive(current);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setLive({
					status: "error",
					error: error instanceof Error ? error.message : String(error),
					notFound: (error as { status?: number }).status === 404,
				});
			});
		return () => {
			cancelled = true;
			off();
		};
	}, [id, onEvent, reload]);
	return live;
}
