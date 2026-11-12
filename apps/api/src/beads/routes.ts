// Work from the UI: create a bead, read it with its timeline, add a note,
// reopen or close it, and read the activity feed, on the work store (NATS
// JetStream). Every route needs a session (requireAccount).
//
//   POST /api/beads                 NewWork            -> 201 Bead
//   GET  /api/beads/:id                                -> BeadDetail
//   POST /api/beads/:id/comments    {text}             -> 201 BeadComment
//   POST /api/beads/:id/reopen      {reason?}          -> Bead (an open bead
//                                   held back with failed:start or needs:human:
//                                   removes the label)
//   POST /api/beads/:id/close       {reason?}          -> Bead
//   GET  /api/activity?before=&limit=                  -> ActivityPage
import {
	type ActivityPage,
	type Bead,
	type BeadComment,
	type BeadDetail,
	type BeadEvent,
	FAILED_START_LABEL,
	foldTimeline,
	isAgentActor,
	NEEDS_HUMAN_LABEL,
	type NewWork,
	type Priority,
	type TimelineEntry,
} from "@mastermind/core";
import { type CreateBead, NotFound, WorkError } from "@mastermind/work";
import type { RequireAccount } from "../auth/session.ts";
import { envLabels } from "./env.ts";

/** What the routes read and write. The NATS work store in production; a fake in tests. */
export type BeadsStore = {
	create(actor: string, input: CreateBead): Promise<Bead>;
	get(id: string): Promise<Bead>;
	comment(id: string, actor: string, text: string): Promise<BeadComment>;
	close(id: string, actor: string, reason?: string): Promise<Bead>;
	reopen(id: string, actor: string, reason?: string): Promise<Bead>;
	setLabels(id: string, actor: string, labels: string[]): Promise<Bead>;
	/** Highest journal seq, 0 when empty. */
	head(): Promise<number>;
	journalOf(id: string): Promise<BeadEvent[]>;
	journalRecent(limit: number, before?: number): Promise<BeadEvent[]>;
	comments(id: string): Promise<BeadComment[]>;
};

export type BeadsRoutesOptions = {
	requireAccount: RequireAccount;
	onError?: (error: unknown) => void;
};

type Req = Request & { params?: Record<string, string> };
type Handler = (req: Req) => Promise<Response>;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, detail?: string) =>
	json(detail ? { error, detail } : { error }, status);

/** A refusal of the request, answered as 400. */
class Invalid extends Error {}

const TYPES = new Set(["task", "bug", "feature", "chore", "epic"]);
const LABEL = /^[^\s,]{1,200}$/;
const NAME = /^[^\s,]{1,200}$/;
export const MAX_TITLE = 300;
export const MAX_TEXT = 20_000;

function str(v: unknown, field: string, max: number, required = false) {
	if (v === undefined || v === null || v === "") {
		if (required) throw new Invalid(`${field} is required`);
		return undefined;
	}
	if (typeof v !== "string") throw new Invalid(`${field} must be a string`);
	const s = v.trim();
	if (required && !s) throw new Invalid(`${field} is required`);
	if (s.length > max) throw new Invalid(`${field} is longer than ${max}`);
	return s || undefined;
}

function names(v: unknown, field: string): string[] {
	if (v === undefined || v === null) return [];
	if (
		!Array.isArray(v) ||
		!v.every((s) => typeof s === "string" && NAME.test(s))
	)
		throw new Invalid(
			`${field} must be a list of names without spaces or commas`,
		);
	return v as string[];
}

/** NewWork from a request body, or Invalid. */
export function parseNewWork(b: Record<string, unknown>): CreateBead {
	const title = str(b.title, "title", MAX_TITLE, true) as string;
	const description = str(b.description, "description", MAX_TEXT);
	const acceptance = str(b.acceptance, "acceptance", MAX_TEXT);
	const type = b.type === undefined ? "task" : b.type;
	if (typeof type !== "string" || !TYPES.has(type))
		throw new Invalid(`type must be one of ${[...TYPES].join(", ")}`);
	const priority = b.priority === undefined ? 2 : b.priority;
	if (
		!Number.isInteger(priority) ||
		(priority as number) < 0 ||
		(priority as number) > 4
	)
		throw new Invalid("priority must be 0 to 4");
	const labels = names(b.labels, "labels");
	if (!labels.every((l) => LABEL.test(l))) throw new Invalid("bad label");
	const env = b.env as NewWork["env"] | undefined | null;
	if (env !== undefined && env !== null) {
		if (typeof env !== "object") throw new Invalid("env must be an object");
		const repo = str(env.repo, "env.repo", 500, true) as string;
		if (!NAME.test(repo)) throw new Invalid("env.repo must have no spaces");
		const ref = str(env.ref, "env.ref", 200);
		const provider = str(env.provider, "env.provider", 100);
		if (ref && !NAME.test(ref))
			throw new Invalid("env.ref must have no spaces");
		if (provider && !NAME.test(provider))
			throw new Invalid("env.provider must have no spaces");
		labels.push(
			...envLabels({
				repo,
				...(ref ? { ref } : {}),
				...(provider ? { provider } : {}),
				requires: names(env.requires, "env.requires"),
			}),
		);
	}
	const input: CreateBead = {
		title,
		type,
		priority: priority as Priority,
		labels: [...new Set(labels)],
	};
	if (description) input.description = description;
	if (acceptance) input.acceptance = acceptance;
	return input;
}

async function body(req: Request): Promise<Record<string, unknown>> {
	if (!req.headers.get("content-type")?.startsWith("application/json"))
		return {};
	try {
		const b = await req.json();
		if (b && typeof b === "object" && !Array.isArray(b))
			return b as Record<string, unknown>;
	} catch {}
	throw new Invalid("body must be a JSON object");
}

/** Comments that the journal does not hold (written before it was on). */
export function olderComments(
	comments: readonly BeadComment[],
	events: readonly BeadEvent[],
): TimelineEntry[] {
	const seen = new Set(events.map((e) => e.comment?.id).filter(Boolean));
	return comments
		.filter((c) => !seen.has(c.id))
		.map((c) => ({
			seq: 0,
			at: c.createdAt,
			beadId: c.beadId,
			kind: isAgentActor(c.author) ? "report" : "note",
			actor: c.author,
			text: c.text,
		}));
}

/** Routes for Bun.serve. A null store (no work store) answers 503. */
export function beadsRoutes(
	store: BeadsStore | null,
	opts: BeadsRoutesOptions,
) {
	const guarded =
		(
			fn: (req: Req, account: string, store: BeadsStore) => Promise<Response>,
		): Handler =>
		async (req) => {
			const who = await opts.requireAccount(req);
			if (who instanceof Response) return who;
			if (!store)
				return fail(
					503,
					"beads unconfigured",
					"Set NATS (auth or DISPATCH_NATS_URL) to serve work.",
				);
			try {
				return await fn(req, who, store);
			} catch (error) {
				if (error instanceof Invalid) return fail(400, error.message);
				if (error instanceof NotFound) return fail(404, "no such bead");
				if (
					error instanceof WorkError &&
					error.status >= 400 &&
					error.status < 500
				)
					return fail(409, error.code, error.message);
				opts.onError?.(error);
				return fail(503, "beads unavailable");
			}
		};
	const idOf = (req: Req) => decodeURIComponent(req.params?.id ?? "");

	async function detail(id: string, s: BeadsStore): Promise<BeadDetail> {
		// Head first: the timeline is at least as new as `seq`.
		const seq = await s.head();
		const [bead, events, comments] = await Promise.all([
			s.get(id),
			s.journalOf(id),
			s.comments(id).catch(() => []),
		]);
		const { entries, ...fold } = foldTimeline(events);
		return {
			bead,
			timeline: [...olderComments(comments, events), ...entries],
			seq: Math.max(seq, events.at(-1)?.seq ?? 0),
			fold,
		};
	}

	return {
		"/api/beads": {
			POST: guarded(async (req, account, s) =>
				json(await s.create(account, parseNewWork(await body(req))), 201),
			),
		},
		"/api/beads/:id": {
			GET: guarded(async (req, _account, s) =>
				json(await detail(idOf(req), s)),
			),
		},
		"/api/beads/:id/comments": {
			POST: guarded(async (req, account, s) => {
				const text = str(
					(await body(req)).text,
					"text",
					MAX_TEXT,
					true,
				) as string;
				return json(await s.comment(idOf(req), account, text), 201);
			}),
		},
		"/api/beads/:id/reopen": {
			POST: guarded(async (req, account, s) => {
				const reason = str((await body(req)).reason, "reason", MAX_TEXT);
				const id = idOf(req);
				const bead = await s.get(id);
				const held = (l: string) =>
					l === FAILED_START_LABEL || l === NEEDS_HUMAN_LABEL;
				if (bead.status !== "closed" && bead.labels.some(held)) {
					// The dispatcher offers it again once the label is gone.
					await s.comment(id, account, `reopened: ${reason ?? "try again"}`);
					return json(
						await s.setLabels(
							id,
							account,
							bead.labels.filter((l) => !held(l)),
						),
					);
				}
				return json(await s.reopen(id, account, reason));
			}),
		},
		"/api/beads/:id/close": {
			POST: guarded(async (req, account, s) => {
				const reason =
					str((await body(req)).reason, "reason", MAX_TEXT) ??
					`closed by ${account}`;
				return json(await s.close(idOf(req), account, reason));
			}),
		},
		"/api/activity": {
			GET: guarded(async (req, _account, s) => {
				const q = new URL(req.url).searchParams;
				const limit = Math.min(Math.max(Number(q.get("limit")) || 200, 1), 500);
				const raw = q.get("before");
				const before = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
				const head = await s.head();
				const page: ActivityPage = {
					events: await s.journalRecent(limit, before),
					head,
				};
				return json(page);
			}),
		},
	};
}

export type BeadsRoutes = ReturnType<typeof beadsRoutes>;
