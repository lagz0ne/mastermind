// The work store as the dispatcher sees it: writes through bd serve, the
// list of claimed beads from Dolt. A fake implements it in tests.
import type { BdClient, ClaimResult, DoltReader } from "@mastermind/beads";
import {
	type Bead,
	type BeadComment,
	queueLabel,
	queueOf,
} from "@mastermind/core";
import type { Heartbeat } from "./heartbeat.ts";

export type Work = {
	/** Ready beads on one queue. */
	ready(queue: string): Promise<Bead[]>;
	get(id: string): Promise<Bead>;
	/** Atomic. Throws AlreadyClaimed when another actor holds the bead. */
	claim(id: string, actor: string): Promise<ClaimResult>;
	/** Pushes the lease forward and returns the bead with it. Only the holder may. */
	heartbeat(id: string, actor: string): Promise<Bead>;
	release(id: string, actor: string): Promise<Bead>;
	close(id: string, actor: string, reason: string): Promise<Bead>;
	comment(id: string, actor: string, text: string): Promise<unknown>;
	/** Replaces the whole label set. */
	setLabels(id: string, actor: string, labels: string[]): Promise<Bead>;
	/** Beads that hold a claim, with their lease. */
	claimed(): Promise<Bead[]>;
	/** Open beads with no queue label (for rerouting after a routing change). */
	unrouted(): Promise<Bead[]>;
	/** Comments on a bead, oldest first; humans' notes go into the prompt. */
	notes?(id: string): Promise<BeadComment[]>;
};

/**
 * `heartbeat` renews leases (see bdHeartbeat). Without it a heartbeat only
 * re-claims, which checks the holder but leaves the lease as it is.
 */
export function beadsWork(
	bd: BdClient,
	reader: DoltReader,
	heartbeat?: Heartbeat,
): Work {
	return {
		ready: (queue) => bd.ready({ label: queueLabel(queue) }),
		get: (id) => bd.get(id),
		claim: (id, actor) => bd.claim(id, actor),
		heartbeat: async (id, actor) => {
			if (heartbeat) await heartbeat(id, actor);
			else await bd.claim(id, actor);
			return bd.get(id);
		},
		release: (id, actor) => bd.release(id, actor),
		close: (id, actor, reason) => bd.close(id, actor, reason),
		comment: (id, actor, text) => bd.comment(id, actor, text),
		setLabels: (id, actor, labels) => bd.update(id, actor, { labels }),
		claimed: async () =>
			(await reader.board()).filter((b) => b.status === "in_progress"),
		notes: (id) => reader.comments(id),
		unrouted: async () =>
			(await reader.board()).filter(
				(b) => b.status === "open" && queueOf(b) === null,
			),
	};
}
