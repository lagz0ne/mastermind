/**
 * The bd serve v0 wire format (snake_case JSON) and its mapping to the
 * `@mastermind/core` domain types. Every shape here was recorded from a real
 * `bd serve` (bd 1.3.4); the recordings live in `fixtures/wire`.
 */
import {
	BEAD_STATUSES,
	type Bead,
	type BeadComment,
	type BeadEvent,
	type BeadStatus,
	type Priority,
} from "@mastermind/core";

/**
 * An issue as bd serializes it: on the HTTP surface and in the events journal
 * (`issue_json`). Empty members are omitted, and `is_blocked` is omitted when
 * false.
 */
export type WireIssue = {
	id: string;
	title: string;
	description?: string;
	acceptance_criteria?: string;
	status: string;
	priority: number;
	issue_type: string;
	assignee?: string;
	labels?: string[];
	is_blocked?: boolean;
	created_at: string;
	updated_at: string;
	started_at?: string;
	closed_at?: string;
	close_reason?: string;
	lease_expires_at?: string;
	heartbeat_at?: string;
};

/** One record of `GET /v0/beads/events`. */
export type WireEvent = {
	seq: number;
	ts: string;
	op: string;
	issue_id: string;
	actor: string;
	/** Absent for a delete. */
	issue?: WireIssue;
	/** Op `comment` only: the comment it added (no issue_id here). */
	comment?: WireEventComment;
};

/** The comment of a journal record, on the HTTP surface and in `comment_json`. */
export type WireEventComment = {
	id: string;
	author: string;
	text: string;
	created_at: string;
};

export type WireComment = {
	id: string;
	issue_id: string;
	author: string;
	text: string;
	created_at: string;
};

/** An RFC 9457 problem document, as every non-2xx answer of bd serve carries. */
export type WireProblem = {
	status: number;
	title: string;
	code: string;
	detail?: string;
	request_id?: string;
	[member: string]: unknown;
};

export type { BeadComment } from "@mastermind/core";

function isBeadStatus(status: string): status is BeadStatus {
	return (BEAD_STATUSES as readonly string[]).includes(status);
}

/**
 * Custom statuses (a workspace can configure its own) are not modelled in core
 * yet. They map to `deferred`, which keeps them off the board instead of
 * putting them in a wrong column.
 */
export function toStatus(status: string): BeadStatus {
	return isBeadStatus(status) ? status : "deferred";
}

export function toPriority(priority: number): Priority {
	const p = Math.round(Number.isFinite(priority) ? priority : 2);
	return Math.min(4, Math.max(0, p)) as Priority;
}

/** Normalizes a timestamp to `toISOString()` form, so every source agrees. */
export function iso(v: Date | string): string {
	return (v instanceof Date ? v : new Date(v)).toISOString();
}

export function toBead(w: WireIssue): Bead {
	const bead: Bead = {
		id: w.id,
		title: w.title,
		status: toStatus(w.status),
		priority: toPriority(w.priority),
		type: w.issue_type,
		labels: w.labels ?? [],
		blocked: w.is_blocked === true,
		createdAt: iso(w.created_at),
		updatedAt: iso(w.updated_at),
	};
	if (w.description) bead.description = w.description;
	if (w.acceptance_criteria) bead.acceptance = w.acceptance_criteria;
	if (w.assignee) bead.assignee = w.assignee;
	if (w.closed_at) bead.closedAt = iso(w.closed_at);
	if (w.close_reason) bead.closeReason = w.close_reason;
	if (w.lease_expires_at) {
		bead.lease = {
			expiresAt: iso(w.lease_expires_at),
			heartbeatAt: iso(w.heartbeat_at ?? w.lease_expires_at),
		};
	}
	return bead;
}

export function toBeadEvent(w: WireEvent): BeadEvent {
	const event: BeadEvent = {
		seq: w.seq,
		at: iso(w.ts),
		op: w.op,
		beadId: w.issue_id,
		actor: w.actor,
	};
	if (w.issue) event.bead = toBead(w.issue);
	if (w.comment) event.comment = toEventComment(w.issue_id, w.comment);
	return event;
}

export function toEventComment(
	beadId: string,
	w: WireEventComment,
): BeadComment {
	return {
		id: w.id,
		beadId,
		author: w.author,
		text: w.text,
		createdAt: iso(w.created_at),
	};
}

export function toBeadComment(w: WireComment): BeadComment {
	return {
		id: w.id,
		beadId: w.issue_id,
		author: w.author,
		text: w.text,
		createdAt: iso(w.created_at),
	};
}
