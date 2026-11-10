/**
 * Work items as Mastermind sees them. The source is beads (bd): one bead is one
 * unit of work. These types are the camelCase domain view; `@mastermind/beads`
 * maps the bd wire format to them.
 */

/** Statuses that bd ships with. */
export const BEAD_STATUSES = [
	"open",
	"in_progress",
	"blocked",
	"deferred",
	"closed",
	"pinned",
	"hooked",
] as const;
export type BeadStatus = (typeof BEAD_STATUSES)[number];

/** 0 is the most urgent. */
export type Priority = 0 | 1 | 2 | 3 | 4;

/** A claim on a bead. bd grants it for a fixed time; the holder must heartbeat. */
export type Lease = {
	/** ISO 8601. After this instant the claim is dead and bd can give the bead away. */
	expiresAt: string;
	heartbeatAt: string;
};

export type Bead = {
	id: string;
	title: string;
	description?: string;
	status: BeadStatus;
	priority: Priority;
	/** bd issue type: task, bug, feature, epic, ... */
	type: string;
	/** The actor that holds the bead, as `<account>/<agent>` for dispatched work. */
	assignee?: string;
	labels: string[];
	/** What "done" means for this bead (bd acceptance criteria). */
	acceptance?: string;
	/** True when an open dependency blocks the bead, whatever its status says. */
	blocked: boolean;
	lease?: Lease;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
	/** Why it was closed; for completed work, the agent's result. */
	closeReason?: string;
};

/** A comment on a bead: a runner's report or a human note. */
export type BeadComment = {
	id: string;
	beadId: string;
	author: string;
	text: string;
	createdAt: string;
};

/** One row of the bd events journal: an ordered, replayable mutation. */
export type BeadEvent = {
	/** Strictly increasing per beads replica. Use it as the resume cursor. */
	seq: number;
	at: string;
	/** create, update, close, reopen, delete, ... */
	op: string;
	beadId: string;
	actor: string;
	/** The bead after the mutation. Absent for a delete. */
	bead?: Bead;
	/** The comment that op `comment` added. */
	comment?: BeadComment;
};

/** Kanban columns, left to right. */
export const BOARD_COLUMNS = [
	"ready",
	"in_progress",
	"blocked",
	"done",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * The column a bead belongs to, or null when it is not on the board
 * (deferred and pinned beads are parked, not flowing).
 */
export function columnOf(
	bead: Pick<Bead, "status" | "blocked">,
): BoardColumn | null {
	switch (bead.status) {
		case "closed":
			return "done";
		case "in_progress":
		case "hooked":
			return "in_progress";
		case "blocked":
			return "blocked";
		case "open":
			return bead.blocked ? "blocked" : "ready";
		default:
			return null;
	}
}

/** A bead is on a queue when it carries the label `queue:<name>`. */
export const QUEUE_LABEL_PREFIX = "queue:";

export function queueLabel(queue: string): string {
	return `${QUEUE_LABEL_PREFIX}${queue}`;
}

/** The queue of a bead, or null when the router has not placed it yet. */
export function queueOf(bead: Pick<Bead, "labels">): string | null {
	const label = bead.labels.find(
		(l) =>
			l.startsWith(QUEUE_LABEL_PREFIX) && l.length > QUEUE_LABEL_PREFIX.length,
	);
	return label ? label.slice(QUEUE_LABEL_PREFIX.length) : null;
}

export type LeaseState = "none" | "live" | "expired";

export function leaseState(
	lease: Lease | undefined,
	now: Date = new Date(),
): LeaseState {
	if (!lease) return "none";
	return Date.parse(lease.expiresAt) > now.getTime() ? "live" : "expired";
}

/**
 * Shape of `GET /api/board`. `seq` is the journal head the snapshot is at
 * least as new as: open `GET /api/events?since=<seq>` to stay current.
 */
export type BoardSnapshot = {
	columns: readonly BoardColumn[];
	beads: Bead[];
	seq: number;
};
