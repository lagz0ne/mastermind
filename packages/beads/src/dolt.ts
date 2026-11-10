import type { Bead, BeadEvent } from "@mastermind/core";
import { iso, toBead, toPriority, toStatus, type WireIssue } from "./wire.ts";

/**
 * The part of a Bun `SQL` instance the reader uses: the tagged template.
 * Pass `new SQL("mysql://user@host:port/<db>")` (Dolt speaks MySQL), or a
 * fake in tests.
 */
export type SqlTag = (
	strings: TemplateStringsArray,
	...values: unknown[]
) => PromiseLike<unknown>;

/** A row of the board query, as Bun's mysql adapter returns it. */
export type BoardRow = {
	id: string;
	title: string;
	description: string | null;
	status: string;
	priority: number;
	issue_type: string;
	assignee: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	closed_at: Date | string | null;
	is_blocked: number | boolean | null;
	/** JSON_ARRAYAGG: Bun parses it, but accept the raw string too. */
	labels: string[] | string | null;
	lease_expires_at: Date | string | null;
	heartbeat_at: Date | string | null;
};

/** A row of `bd_events_journal`. */
export type JournalRow = {
	seq: number | bigint | string;
	ts: Date | string;
	op: string;
	issue_id: string;
	actor: string | null;
	/** The bead after the mutation, as bd serializes it. Null for a delete. */
	issue_json: string | null;
};

/**
 * Reads beads straight from Dolt. Reads only: every write goes through
 * {@link BdClient} so claims, leases and the journal stay correct.
 */
export class DoltReader {
	readonly #sql: SqlTag;

	constructor(sql: SqlTag) {
		this.#sql = sql;
	}

	/**
	 * Every bead on the board, with labels, the blocked flag and the live lease,
	 * in one query. Flowing statuses: open, in_progress, hooked, blocked. Done beads are limited to those closed since `doneSince`
	 * (default: the last 7 days). Ephemeral beads (wisps) are left out.
	 */
	async board(options: { doneSince?: Date } = {}): Promise<Bead[]> {
		const doneSince =
			options.doneSince ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		const rows = (await this.#sql`
			select i.id, i.title, i.description, i.status, i.priority, i.issue_type,
				i.assignee, i.created_at, i.updated_at, i.closed_at, i.is_blocked,
				(select json_arrayagg(l.label) from labels l where l.issue_id = i.id) as labels,
				le.lease_expires_at, le.heartbeat_at
			from issues i
			left join leases le on le.issue_id = i.id
			where coalesce(i.ephemeral, 0) = 0
				and (i.status in ('open', 'in_progress', 'hooked', 'blocked')
					or (i.status = 'closed' and i.closed_at >= ${doneSince}))
			order by i.priority, i.created_at, i.id
		`) as BoardRow[];
		return rows.map(boardRowToBead);
	}

	/** Journal records with seq greater than `seq`, in seq order. */
	async journalSince(seq: number, limit = 500): Promise<BeadEvent[]> {
		const rows = (await this.#sql`
			select seq, ts, op, issue_id, actor, issue_json
			from bd_events_journal
			where seq > ${seq}
			order by seq
			limit ${limit}
		`) as JournalRow[];
		return rows.map(journalRowToEvent);
	}
}

function labelsOf(v: BoardRow["labels"]): string[] {
	if (v == null) return [];
	const list: unknown = typeof v === "string" ? JSON.parse(v) : v;
	return Array.isArray(list)
		? list.filter((l): l is string => typeof l === "string").sort()
		: [];
}

export function boardRowToBead(r: BoardRow): Bead {
	const bead: Bead = {
		id: r.id,
		title: r.title,
		status: toStatus(r.status),
		priority: toPriority(r.priority),
		type: r.issue_type,
		labels: labelsOf(r.labels),
		blocked: Boolean(r.is_blocked),
		createdAt: iso(r.created_at),
		updatedAt: iso(r.updated_at),
	};
	if (r.description) bead.description = r.description;
	if (r.assignee) bead.assignee = r.assignee;
	if (r.closed_at) bead.closedAt = iso(r.closed_at);
	if (r.lease_expires_at) {
		bead.lease = {
			expiresAt: iso(r.lease_expires_at),
			heartbeatAt: iso(r.heartbeat_at ?? r.lease_expires_at),
		};
	}
	return bead;
}

export function journalRowToEvent(r: JournalRow): BeadEvent {
	const event: BeadEvent = {
		seq: Number(r.seq),
		at: iso(r.ts),
		op: r.op,
		beadId: r.issue_id,
		actor: r.actor ?? "",
	};
	if (r.issue_json) event.bead = toBead(JSON.parse(r.issue_json) as WireIssue);
	return event;
}
