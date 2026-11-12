/**
 * Work items as Mastermind sees them: one bead is one unit of work. The work
 * store (@mastermind/work, NATS JetStream) keeps them in this shape.
 */

/** Statuses of a work item. */
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
	/** What the work left on the git host (box output); set when it completes. */
	output?: WorkOutput;
};

/**
 * What a completed item left on the git host: the branch the runner pushed and
 * the pull request, when it opened or found one.
 */
export type WorkOutput = {
	/** Branch on the git host; absent when nothing was pushed. */
	branch?: string;
	/** The pull request (http or https URL). */
	prUrl?: string;
	/** Commits on top of the base. */
	commits: number;
	filesChanged: number;
};

const OUTPUT_TEXT_MAX = 500;

/**
 * A clean WorkOutput from untrusted input (the runner), or null when it is not
 * one. A prUrl that is not http(s) is dropped: the UI renders it as a link.
 */
export function workOutputOf(v: unknown): WorkOutput | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const count = (n: unknown) =>
		typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
	const commits = count(o.commits);
	const filesChanged = count(o.filesChanged);
	if (commits === null || filesChanged === null) return null;
	const out: WorkOutput = { commits, filesChanged };
	if (
		typeof o.branch === "string" &&
		o.branch.trim() &&
		o.branch.length <= OUTPUT_TEXT_MAX
	)
		out.branch = o.branch.trim();
	if (typeof o.prUrl === "string" && o.prUrl.length <= OUTPUT_TEXT_MAX) {
		try {
			const url = new URL(o.prUrl);
			if (url.protocol === "https:" || url.protocol === "http:")
				out.prUrl = url.href;
		} catch {}
	}
	return out;
}

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
