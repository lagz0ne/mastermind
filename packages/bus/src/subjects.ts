/**
 * The one place that builds and parses Mastermind subjects (v0):
 *
 *   mm.u.<account>.q.<queue>.next    request: next dispatch for a runner
 *   mm.u.<account>.d.<bead>.<verb>    request: heartbeat | report | complete | release
 *   mm.u.<account>.r.<runner>.status publish: a runner's diagnostics (runnerToken)
 *   mm.u.<account>.r.<runner>.doctor request: run the runner's doctor (operator);
 *                                    the reply goes to ...doctor.reply.<nonce>, a
 *                                    subject the runner may publish to
 *   mm.q.<queue>.ready               publish: a queue has work
 *   mm.events.bead.<bead>            publish: one bead changed (beads journal)
 *
 * <account> is the account id: the human who owns the work. A runner adapter
 * connects as a service account owned by that account; every subject it may use
 * sits under `mm.u.<account>.>`, so the auth callout scopes its JWT to exactly
 * that prefix.
 *
 * Account ids and queues are single NATS tokens: no '.', '*', '>' or whitespace.
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

/**
 * A runner id as one subject token: characters outside [A-Za-z0-9_-] become
 * '_' (host names have dots). The payload carries the real id.
 */
export function runnerToken(id: string): string {
	const t = id.replace(/[^A-Za-z0-9_-]/g, "_");
	if (t === "") throw new SubjectError("bad runner id: empty");
	return t;
}

function beadFromToken(t: string): string {
	return t.replaceAll("~", ".");
}

export const subjects = {
	next: (account: string, queue: string) =>
		`mm.u.${token("account", account)}.q.${token("queue", queue)}.next`,
	bead: (account: string, bead: string, verb: BeadVerb) =>
		`mm.u.${token("account", account)}.d.${beadToken(bead)}.${verb}`,
	runnerStatus: (account: string, runner: string) =>
		`mm.u.${token("account", account)}.r.${runnerToken(runner)}.status`,
	/** Request to a runner: run its doctor, reply with the report (mm-210.47). */
	runnerDoctor: (account: string, runner: string) =>
		`mm.u.${token("account", account)}.r.${runnerToken(runner)}.doctor`,
	/** Where a runner answers one doctor request (inside its publish scope). */
	runnerDoctorReply: (account: string, runner: string, nonce: string) =>
		`mm.u.${token("account", account)}.r.${runnerToken(runner)}.doctor.reply.${token("nonce", nonce)}`,
	/** The doctor requests of every runner of an account (the runner's subscribe permission). */
	runnerDoctorScope: (account: string) =>
		`mm.u.${token("account", account)}.r.*.doctor`,
	ready: (queue: string) => `mm.q.${token("queue", queue)}.ready`,
	beadEvent: (bead: string) => `mm.events.bead.${beadToken(bead)}`,
	/** Everything an account's service accounts may publish to (for the auth callout). */
	accountScope: (account: string) => `mm.u.${token("account", account)}.>`,
} as const;

/** Wildcards that Mastermind serves or that adapters subscribe to. */
export const patterns = {
	next: "mm.u.*.q.*.next",
	bead: (verb: BeadVerb) => `mm.u.*.d.*.${verb}`,
	allBeadVerbs: "mm.u.*.d.*.*",
	runnerStatus: "mm.u.*.r.*.status",
	ready: "mm.q.*.ready",
	beadEvents: "mm.events.bead.*",
} as const;

export type ParsedSubject =
	| { kind: "next"; account: string; queue: string }
	| { kind: "bead"; account: string; bead: string; verb: BeadVerb }
	| { kind: "runnerStatus"; account: string; runner: string }
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
			return { kind: "next", account: b, queue: d };
		if (c === "d" && e !== undefined && isVerb(e))
			return { kind: "bead", account: b, bead: beadFromToken(d), verb: e };
		if (c === "r" && e === "status" && !d.includes("~"))
			return { kind: "runnerStatus", account: b, runner: d };
		return null;
	}
	if (a === "q" && p.length === 4 && ok(b) && !b.includes("~") && c === "ready")
		return { kind: "ready", queue: b };
	if (a === "events" && b === "bead" && p.length === 4 && ok(c))
		return { kind: "beadEvent", bead: beadFromToken(c) };
	return null;
}
