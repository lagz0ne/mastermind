import type { WireProblem } from "./wire.ts";

/**
 * A refusal or failure from bd serve. `code` is bd's frozen error vocabulary
 * (`invalid_argument`, `not_releasable`, `precondition_failed`, ...), or
 * `http_<status>` when the body was not a problem document.
 */
export class BdError extends Error {
	override name = "BdError";
	readonly status: number;
	readonly code: string;
	readonly problem?: WireProblem;

	constructor(
		status: number,
		code: string,
		message: string,
		problem?: WireProblem,
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.problem = problem;
	}
}

/** 409 `already_claimed`: another actor holds the bead. */
export class AlreadyClaimed extends BdError {
	override name = "AlreadyClaimed";
	/** The actor that holds the claim. */
	readonly assignee?: string;

	constructor(problem: WireProblem) {
		super(409, "already_claimed", problem.detail ?? "already claimed", problem);
		if (typeof problem.assignee === "string") this.assignee = problem.assignee;
	}
}

/** 404 `not_found`: no bead with that id. */
export class NotFound extends BdError {
	override name = "NotFound";

	constructor(problem: WireProblem) {
		super(404, "not_found", problem.detail ?? "not found", problem);
	}
}

function isProblem(body: unknown): body is WireProblem {
	return (
		typeof body === "object" &&
		body !== null &&
		typeof (body as WireProblem).code === "string"
	);
}

/** Turns a non-2xx response into the matching typed error. */
export async function errorFrom(res: Response): Promise<BdError> {
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (!isProblem(body)) {
		return new BdError(
			res.status,
			`http_${res.status}`,
			text.slice(0, 200) || res.statusText,
		);
	}
	if (body.code === "already_claimed") return new AlreadyClaimed(body);
	if (body.code === "not_found") return new NotFound(body);
	return new BdError(res.status, body.code, body.detail ?? body.title, body);
}
