/**
 * The one place that builds and parses Mastermind subjects (v0):
 *
 *   mm.u.<user>.q.<queue>.next       request: next dispatch for a runner
 *   mm.u.<user>.d.<bead>.<verb>      request: heartbeat | report | complete | release
 *   mm.q.<queue>.ready               publish: a queue has work
 *   mm.events.bead.<bead>            publish: one bead changed (beads journal)
 *
 * Every user subject sits under `mm.u.<user>.>`, so the auth callout can scope
 * a user's JWT to exactly that prefix.
 *
 * Users and queues are single NATS tokens: no '.', '*', '>' or whitespace.
 * Bead ids are different: child beads have dots (`mm-210.14`). In a subject a
 * bead id is written with '.' as '~' (`mm-210~14`); parse turns it back.
 */

export const BEAD_VERBS = [
	"heartbeat",
	"report",
	"complete",
	"release",
] as const;
export type BeadVerb = (typeof BEAD_VERBS)[number];

/** The queue group that every Mastermind replica serves in. */
export const SERVICE_QUEUE = "mastermind";

export class SubjectError extends Error {
	override name = "SubjectError";
}

const BAD_TOKEN = /[.*>~\s]/;
const BAD_BEAD = /[*>~\s]/;

/** Throws unless `value` is a safe single subject token. */
export function token(kind: string, value: string): string {
	if (value === "" || BAD_TOKEN.test(value)) {
		throw new SubjectError(`bad ${kind} token: ${JSON.stringify(value)}`);
	}
	return value;
}

/** A bead id as one subject token ('.' becomes '~'). */
export function beadToken(id: string): string {
	if (
		id === "" ||
		BAD_BEAD.test(id) ||
		id.startsWith(".") ||
		id.endsWith(".") ||
		id.includes("..")
	) {
		throw new SubjectError(`bad bead id: ${JSON.stringify(id)}`);
	}
	return id.replaceAll(".", "~");
}

function beadFromToken(t: string): string {
	return t.replaceAll("~", ".");
}

export const subjects = {
	next: (user: string, queue: string) =>
		`mm.u.${token("user", user)}.q.${token("queue", queue)}.next`,
	bead: (user: string, bead: string, verb: BeadVerb) =>
		`mm.u.${token("user", user)}.d.${beadToken(bead)}.${verb}`,
	ready: (queue: string) => `mm.q.${token("queue", queue)}.ready`,
	beadEvent: (bead: string) => `mm.events.bead.${beadToken(bead)}`,
	/** Everything a user may publish to (for the auth callout). */
	userScope: (user: string) => `mm.u.${token("user", user)}.>`,
} as const;

/** Wildcards that Mastermind serves or that adapters subscribe to. */
export const patterns = {
	next: "mm.u.*.q.*.next",
	bead: (verb: BeadVerb) => `mm.u.*.d.*.${verb}`,
	allBeadVerbs: "mm.u.*.d.*.*",
	ready: "mm.q.*.ready",
	beadEvents: "mm.events.bead.*",
} as const;

export type ParsedSubject =
	| { kind: "next"; user: string; queue: string }
	| { kind: "bead"; user: string; bead: string; verb: BeadVerb }
	| { kind: "ready"; queue: string }
	| { kind: "beadEvent"; bead: string };

const isVerb = (v: string): v is BeadVerb =>
	(BEAD_VERBS as readonly string[]).includes(v);
const ok = (t: string | undefined): t is string =>
	t !== undefined && t !== "" && !/[*>\s]/.test(t);

/** The meaning of a concrete subject, or null when it is not one of ours. */
export function parseSubject(subject: string): ParsedSubject | null {
	const p = subject.split(".");
	if (p[0] !== "mm") return null;
	const [, a, b, c, d, e] = p;
	if (a === "u" && p.length === 6 && ok(b) && ok(d) && !b.includes("~")) {
		if (c === "q" && e === "next" && !d.includes("~"))
			return { kind: "next", user: b, queue: d };
		if (c === "d" && e !== undefined && isVerb(e))
			return { kind: "bead", user: b, bead: beadFromToken(d), verb: e };
		return null;
	}
	if (a === "q" && p.length === 4 && ok(b) && !b.includes("~") && c === "ready")
		return { kind: "ready", queue: b };
	if (a === "events" && b === "bead" && p.length === 4 && ok(c))
		return { kind: "beadEvent", bead: beadFromToken(c) };
	return null;
}
