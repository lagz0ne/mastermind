import type { Bead, BeadEvent, BeadStatus, Priority } from "@mastermind/core";
import { errorFrom } from "./errors.ts";
import {
	type BeadComment,
	toBead,
	toBeadComment,
	toBeadEvent,
	type WireComment,
	type WireEvent,
	type WireIssue,
} from "./wire.ts";

export type BdClientOptions = {
	/** Where bd serve listens, e.g. `http://127.0.0.1:47411`. */
	baseUrl: string;
	/** Sent as `Authorization: Bearer <token>` when bd serve runs with `--auth-token-file`. */
	token?: string;
	/** Injected for tests. Defaults to the global fetch. */
	fetch?: (input: Request) => Promise<Response>;
};

export type CreateBead = {
	title: string;
	description?: string;
	priority?: Priority;
	/** bd issue type. bd defaults to `task`. */
	type?: string;
	labels?: string[];
};

/** Members of `PATCH /v0/beads/issues/{id}` that Mastermind uses. */
export type BeadPatch = {
	title?: string;
	description?: string;
	status?: BeadStatus;
	priority?: Priority;
	assignee?: string;
	/** Replaces the whole label set. */
	labels?: string[];
};

export type ClaimResult = {
	/**
	 * bd omits labels from the claim response, so `labels` is `[]` here even
	 * when the bead has some. Read the bead again (or the journal) for them.
	 */
	bead: Bead;
	/** True when this actor already held the claim: the call was a heartbeat. */
	alreadyClaimed: boolean;
};

export type EventsPage = {
	/** The journal's newest seq, whatever the page holds. */
	head: number;
	events: BeadEvent[];
};

/**
 * Typed client for the bd serve v0 HTTP API. Writes go here so that bd keeps
 * claims, leases and the events journal correct.
 *
 * Errors: {@link AlreadyClaimed} (409), {@link NotFound} (404), otherwise
 * {@link BdError} with bd's error `code`.
 */
export class BdClient {
	readonly #base: string;
	readonly #token?: string;
	readonly #fetch: (input: Request) => Promise<Response>;

	constructor(options: BdClientOptions) {
		this.#base = `${options.baseUrl.replace(/\/+$/, "")}/v0/beads`;
		this.#token = options.token;
		this.#fetch = options.fetch ?? ((req) => fetch(req));
	}

	async #call<T>(
		method: "GET" | "POST" | "PATCH",
		path: string,
		body?: unknown,
	): Promise<T> {
		const headers = new Headers({ accept: "application/json" });
		if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
		if (body !== undefined) headers.set("content-type", "application/json");
		const res = await this.#fetch(
			new Request(`${this.#base}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		if (!res.ok) throw await errorFrom(res);
		return (await res.json()) as T;
	}

	/** Beads that are ready to work on, optionally on one label (a queue). */
	async ready(
		options: { label?: string; limit?: number } = {},
	): Promise<Bead[]> {
		const q = new URLSearchParams();
		if (options.label) q.set("label", options.label);
		if (options.limit !== undefined) q.set("limit", String(options.limit));
		const qs = q.size ? `?${q}` : "";
		const page = await this.#call<{ items: WireIssue[] }>("GET", `/ready${qs}`);
		return page.items.map(toBead);
	}

	async get(id: string): Promise<Bead> {
		return toBead(await this.#call<WireIssue>("GET", `/issues/${enc(id)}`));
	}

	async create(actor: string, input: CreateBead): Promise<Bead> {
		const body: Record<string, unknown> = { actor, title: input.title };
		if (input.description !== undefined) body.description = input.description;
		if (input.priority !== undefined) body.priority = input.priority;
		if (input.type !== undefined) body.issue_type = input.type;
		if (input.labels !== undefined) body.labels = input.labels;
		return toBead(await this.#call<WireIssue>("POST", "/issues", body));
	}

	async update(id: string, actor: string, patch: BeadPatch): Promise<Bead> {
		const res = await this.#call<{ issue: WireIssue }>(
			"PATCH",
			`/issues/${enc(id)}`,
			{ actor, patch },
		);
		return toBead(res.issue);
	}

	/**
	 * Atomic claim with a lease (5 minutes on bd 1.3.4). Claiming again as the
	 * same actor renews the lease. Throws {@link AlreadyClaimed} when another
	 * actor holds it.
	 */
	async claim(id: string, actor: string): Promise<ClaimResult> {
		const res = await this.#call<{
			issue: WireIssue;
			already_claimed: boolean;
		}>("POST", `/issues/${enc(id)}:claim`, { actor });
		return { bead: toBead(res.issue), alreadyClaimed: res.already_claimed };
	}

	/**
	 * Gives a claim back. Not idempotent: a bead that holds no claim answers
	 * {@link BdError} with code `not_releasable`.
	 */
	async release(id: string, actor: string): Promise<Bead> {
		const res = await this.#call<{ issue: WireIssue }>(
			"POST",
			`/issues/${enc(id)}:release`,
			{ actor },
		);
		return toBead(res.issue);
	}

	/** Idempotent: closing a closed bead returns it unchanged. */
	async close(id: string, actor: string, reason?: string): Promise<Bead> {
		const body: Record<string, unknown> = { actor };
		if (reason !== undefined) body.reason = reason;
		const res = await this.#call<{ issue: WireIssue }>(
			"POST",
			`/issues/${enc(id)}:close`,
			body,
		);
		return toBead(res.issue);
	}

	async comment(id: string, actor: string, text: string): Promise<BeadComment> {
		// This operation names the actor `author`.
		const res = await this.#call<WireComment>(
			"POST",
			`/issues/${enc(id)}/comments`,
			{ author: actor, text },
		);
		return toBeadComment(res);
	}

	/** Journal records with seq greater than `since`, in seq order. */
	async events(since: number, limit?: number): Promise<EventsPage> {
		const q = new URLSearchParams({ since: String(since) });
		if (limit !== undefined) q.set("limit", String(limit));
		const page = await this.#call<{ head: number; records: WireEvent[] }>(
			"GET",
			`/events?${q}`,
		);
		return { head: page.head, events: page.records.map(toBeadEvent) };
	}
}

function enc(id: string): string {
	return encodeURIComponent(id);
}
