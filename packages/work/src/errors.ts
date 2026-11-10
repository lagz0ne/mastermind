import type { Bead, Priority } from "@mastermind/core";

/** An RFC 9457 style problem: what a refusal of the work store carries. */
export type Problem = {
	status: number;
	title: string;
	code: string;
	detail?: string;
	[member: string]: unknown;
};

/**
 * A refusal or failure of the work store. `code` is a stable word
 * (`not_releasable`, `heartbeat_refused`, `conflict`, ...).
 */
export class WorkError extends Error {
	override name = "WorkError";
	readonly status: number;
	readonly code: string;
	readonly problem?: Problem;

	constructor(
		status: number,
		code: string,
		message: string,
		problem?: Problem,
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.problem = problem;
	}
}

/** 409 `already_claimed`: another actor holds the item. */
export class AlreadyClaimed extends WorkError {
	override name = "AlreadyClaimed";
	/** The actor that holds the claim. */
	readonly assignee?: string;

	constructor(problem: Problem) {
		super(409, "already_claimed", problem.detail ?? "already claimed", problem);
		if (typeof problem.assignee === "string") this.assignee = problem.assignee;
	}
}

/** 404 `not_found`: no item with that id. */
export class NotFound extends WorkError {
	override name = "NotFound";

	constructor(problem: Problem) {
		super(404, "not_found", problem.detail ?? "not found", problem);
	}
}

export type CreateBead = {
	title: string;
	description?: string;
	/** Acceptance criteria. */
	acceptance?: string;
	priority?: Priority;
	/** Item type. Default `task`. */
	type?: string;
	labels?: string[];
};

export type ClaimResult = {
	bead: Bead;
	/** True when this actor already held the claim: the call was a heartbeat. */
	alreadyClaimed: boolean;
};
