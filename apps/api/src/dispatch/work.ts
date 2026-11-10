// The work store as the dispatcher sees it: the NATS store (@mastermind/work)
// in production, a fake in tests.
import type { Bead, BeadComment } from "@mastermind/core";
import type { ClaimResult } from "@mastermind/work";

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
