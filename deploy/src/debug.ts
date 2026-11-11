/**
 * `bun deploy/dokploy.ts debug state|item <id>|events [--follow] [--since n]|errors|doctor <account>/<runner> [--deep] [--json]`:
 * the operator's read-only view of a running Mastermind (GET <url>/api/debug/*,
 * Bearer operator key).
 * The key is never printed.
 */

export type DebugArgs =
	| { what: "state"; json: boolean }
	| { what: "errors"; json: boolean }
	| { what: "item"; id: string; json: boolean }
	| { what: "events"; follow: boolean; since: number; json: boolean }
	| {
			what: "doctor";
			account: string;
			runner: string;
			deep: boolean;
			json: boolean;
	  };

export function parseDebugArgs(argv: string[]): DebugArgs | null {
	const json = argv.includes("--json");
	const follow = argv.includes("--follow") || argv.includes("-f");
	const deep = argv.includes("--deep");
	let since = 0;
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--json" || a === "--follow" || a === "-f" || a === "--deep")
			continue;
		if (a === "--since") {
			since = Number(argv[++i]);
			if (!Number.isInteger(since) || since < 0) return null;
		} else rest.push(a);
	}
	const [what, id, ...more] = rest;
	if (more.length) return null;
	if ((what === "state" || what === "errors") && !id) return { what, json };
	if (what === "item" && id) return { what, id, json };
	if (what === "events" && !id) return { what, follow, since, json };
	if (what === "doctor" && id) {
		const [account, runner, extra] = id.split("/");
		if (!account || !runner || extra !== undefined) return null;
		return { what, account, runner, deep, json };
	}
	return null;
}

/** The path under /api/debug/ for `args`. */
export function debugPath(args: DebugArgs): string {
	switch (args.what) {
		case "item":
			return `items/${encodeURIComponent(args.id)}`;
		case "events":
			return `events?since=${args.since}${args.follow ? "&follow=1" : ""}`;
		case "doctor":
			return `runners/${encodeURIComponent(args.account)}/${encodeURIComponent(args.runner)}/doctor${args.deep ? "?deep=1" : ""}`;
		default:
			return "state";
	}
}

/** Read an SSE answer; call `onEvent` per event until the stream ends. */
export async function followDebug(
	url: string,
	key: string,
	path: string,
	onEvent: (event: string, data: unknown) => void,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const res = await fetcher(`${url.replace(/\/$/, "")}/api/debug/${path}`, {
		headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
	});
	if (!res.ok || !res.body) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(debugError(res.status, body.error ?? ""));
	}
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of res.body) {
		buf += decoder.decode(chunk, { stream: true });
		let i = buf.indexOf("\n\n");
		while (i >= 0) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			let event = "message";
			let data = "";
			for (const line of block.split("\n")) {
				if (line.startsWith("event: ")) event = line.slice(7);
				else if (line.startsWith("data: ")) data += line.slice(6);
			}
			if (data) onEvent(event, JSON.parse(data));
			i = buf.indexOf("\n\n");
		}
	}
}

/** One event of `debug events` as one line for a human. */
export function formatEvent(event: string, d: Any): string {
	switch (event) {
		case "work":
			return `work    #${d.seq} ${d.at}  ${d.op} ${d.item}  by ${d.actor}  -> ${d.status ?? "-"}${d.assignee ? ` (${d.assignee})` : ""}  queue ${d.queue ?? "-"}${d.comment ? `  "${d.comment}"` : ""}`;
		case "runner":
			return d.gone
				? `runner  ${d.runner}  gone`
				: `runner  ${d.runner}  ${d.online ? "ONLINE" : "OFFLINE"}  queues ${list(d.queues)}  running ${list(d.running)}  state ${d.state ?? "-"}  reconnects ${d.reconnects ?? "-"}  seen ${d.lastSeenAt}${d.lastError ? `  last error: ${d.lastError}` : ""}`;
		case "error":
			return `error   ${d.at}  ${d.line}`;
		default:
			return `${event}  ${JSON.stringify(d)}`;
	}
}

/** The events page (no --follow) as text. */
export function formatEvents(p: Any): string {
	return [
		...((p.work ?? []) as Any[]).map((w) => formatEvent("work", w)),
		...((p.runners ?? []) as Any[]).map((r) => formatEvent("runner", r)),
		...((p.errors ?? []) as Any[]).map((e) => formatEvent("error", e)),
		`(next: --since ${p.next})`,
	].join("\n");
}

/** Every error line of the state snapshot. */
export function formatErrors(s: Any): string {
	const lines = (s.errors ?? []) as Any[];
	if (!lines.length) return "(no error lines)";
	return lines.map((l) => `${l.at}  ${l.line}`).join("\n");
}

export const DEBUG_USAGE =
	"usage: bun deploy/dokploy.ts debug state | item <id> | events [--follow] [--since <seq>] | errors | doctor <account>/<runner> [--deep]   [--json]  (MASTERMIND_URL + MASTERMIND_OPERATOR_KEY from env, else the app env in Dokploy)";

export async function fetchDebug(
	url: string,
	key: string,
	path: string,
	fetcher: typeof fetch = fetch,
	opts: { method?: "GET" | "POST"; timeoutMs?: number } = {},
): Promise<unknown> {
	const res = await fetcher(`${url.replace(/\/$/, "")}/api/debug/${path}`, {
		method: opts.method ?? "GET",
		headers: { authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
	});
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new Error(debugError(res.status, body.error ?? ""));
	return body;
}

export function debugError(status: number, error: string): string {
	switch (status) {
		case 401:
			return "the app refused the operator key (MASTERMIND_OPERATOR_KEY).";
		case 404:
			return `HTTP 404: ${error || "not found"}. Is the operator key in the app env, and does the app run a commit with /api/debug?`;
		case 429:
			return "too many requests; wait a minute.";
		default:
			return `HTTP ${status}: ${error}`;
	}
}

type Err = { error: string };
const isErr = (v: unknown): v is Err =>
	typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v;

/** Fixed-width columns. */
export function table(head: string[], rows: string[][]): string {
	if (!rows.length) return "  (none)";
	const w = head.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	const line = (r: string[]) =>
		`  ${r.map((c, i) => (c ?? "").padEnd(w[i] ?? 0)).join("  ")}`.trimEnd();
	return [line(head), ...rows.map(line)].join("\n");
}

function ago(iso: string | null | undefined, now: Date): string {
	if (!iso) return "-";
	const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
	if (s < 0) return `in ${-s}s`;
	if (s < 120) return `${s}s ago`;
	if (s < 7200) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(",") : "-");

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, printed defensively
type Any = any;

/** The state snapshot as text for a human. */
export function formatState(s: Any): string {
	const now = new Date(s.now ?? Date.now());
	const out: string[] = [];
	const head = (t: string) => out.push("", `== ${t}`);
	const section = (t: string, v: unknown, body: (v: Any) => string) => {
		head(t);
		out.push(isErr(v) ? `  ERROR: ${v.error}` : body(v));
	};
	out.push(
		`mastermind ${s.version}  up ${s.uptimeSeconds}s (since ${s.startedAt})  now ${s.now}`,
	);
	section("nats connections", s.nats, (v) =>
		table(
			["name", "state", "server", "reconnects", "last error"],
			(v as Any[]).map((c) => [
				c.name,
				c.state,
				c.server ?? "-",
				String(c.reconnects),
				c.lastError ? `${c.lastError} (${ago(c.lastErrorAt, now)})` : "-",
			]),
		),
	);
	section("accounts", s.accounts, (v) =>
		table(
			["id", "created", "invited by"],
			(v as Any[]).map((a) => [a.id, a.createdAt, a.invitedBy ?? "-"]),
		),
	);
	section("service accounts", s.serviceAccounts, (v) =>
		table(
			["account", "id", "name", "created"],
			(v as Any[]).map((a) => [a.account, a.id, a.name, a.createdAt]),
		),
	);
	section("runners", s.runners, (v) =>
		table(
			[
				"account/runner",
				"online",
				"last seen",
				"version",
				"queues",
				"cap",
				"running",
				"missing secrets",
				"service account",
			],
			(v as Any[]).map((r) => [
				`${r.account}/${r.runner}`,
				r.online ? "yes" : "NO",
				ago(r.lastSeenAt, now),
				r.version ?? "-",
				list(r.queues),
				r.capacity == null ? "-" : String(r.capacity),
				list(r.running),
				// Names only (mm-210.51); "-": the runner does not report secrets.
				r.diagnostics?.secrets
					? r.diagnostics.secrets.missing?.length
						? list(r.diagnostics.secrets.missing)
						: "none"
					: "-",
				r.serviceAccount ?? "-",
			]),
		),
	);
	if (!isErr(s.runners))
		for (const r of s.runners as Any[])
			if (r.diagnostics?.lastDoctor)
				out.push(
					...doctorSummary(
						`${r.account}/${r.runner}`,
						r.diagnostics.lastDoctor,
						now,
					),
				);
	section("routing", s.routing, (v) => {
		const doc = v.doc ?? {};
		const lines = [
			`  revision ${v.revision}  default queue ${doc.defaultQueue ?? "-"}`,
		];
		lines.push(
			table(
				["queue", "members"],
				(doc.queues ?? []).map((q: Any) => [q.name, list(q.members)]),
			),
		);
		lines.push(
			"  rules:",
			...(doc.rules ?? []).map(
				(r: Any, i: number) => `    ${i}. ${JSON.stringify(r)}`,
			),
		);
		return lines.join("\n");
	});
	section("environments", s.environments, (v) =>
		[
			`  revision ${v.revision}`,
			...(v.doc?.environments ?? []).map(
				(e: Any) => `    ${JSON.stringify(e)}`,
			),
		].join("\n"),
	);
	section("items", s.items, (v) => {
		const lines = [
			`  total ${v.total}  columns ${JSON.stringify(v.columns)}`,
			`  ready per queue ${JSON.stringify(v.readyPerQueue)}`,
			`  unrouted (open, no queue): ${list(v.unrouted)}`,
			"  claimed:",
			table(
				["id", "status", "queue", "holder", "lease", "expires", "heartbeat"],
				(v.claimed as Any[]).map((c) => [
					c.id,
					c.status,
					c.queue ?? "-",
					c.holder ?? "-",
					c.lease,
					ago(c.leaseExpiresAt, now),
					ago(c.heartbeatAt, now),
				]),
			),
		];
		return lines.join("\n");
	});
	section("last errors", s.errors, (v) => {
		const lines = (v as Any[]).slice(-20);
		if (!lines.length) return "  (none)";
		return lines.map((l) => `  ${l.at}  ${l.line}`).join("\n");
	});
	return out.join("\n");
}

const MARK: Record<string, string> = {
	pass: "PASS",
	warn: "WARN",
	fail: "FAIL",
	skip: "SKIP",
};

/** A runner doctor report (mastermind-runner doctor.ts), as text. */
export function formatDoctor(r: Any): string {
	const out = [
		`runner ${r.runner} doctor at ${r.at}${r.deep ? " (deep)" : ""}: ${r.ok ? "no failure" : "FAIL"}`,
	];
	for (const st of (r.steps ?? []) as Any[]) {
		out.push(
			`${MARK[st.status] ?? st.status} ${st.id}. ${st.name} (${st.ms} ms)`,
		);
		for (const l of (st.detail ?? []) as string[]) out.push(`     ${l}`);
		if (st.fix && (st.status === "warn" || st.status === "fail"))
			out.push(`     fix: ${st.fix}`);
	}
	return out.join("\n");
}

/** One line per step, and the problems with their fix: for `debug state`. */
function doctorSummary(who: string, r: Any, now: Date): string[] {
	const steps = (r.steps ?? []) as Any[];
	const out = [
		`  doctor ${who} ${ago(r.at, now)}${r.deep ? " (deep)" : ""}: ${steps
			.map((st) => `${st.id} ${MARK[st.status] ?? st.status}`)
			.join(", ")}`,
	];
	for (const st of steps)
		if (st.status === "warn" || st.status === "fail")
			out.push(
				`    ${st.id}. ${st.problem ?? (st.detail ?? []).at(-1) ?? ""}${st.fix ? `  fix: ${st.fix}` : ""}`,
			);
	return out;
}

/** One item and why it is or is not dispatched, as text for a human. */
export function formatItem(x: Any): string {
	const b = x.item ?? {};
	const r = x.routing ?? {};
	const out = [
		`${b.id}  ${b.title}`,
		`  status ${b.status}${b.blocked ? " (blocked)" : ""}  type ${b.type}  priority ${b.priority}`,
		`  labels ${list(b.labels)}`,
		`  holder ${b.assignee ?? "-"}  lease ${b.lease ? `expires ${b.lease.expiresAt}, heartbeat ${b.lease.heartbeatAt}` : "-"}`,
		"",
		"== routing",
		`  queue ${r.queue ?? "-"} (by ${r.by}${r.ruleIndex != null ? ` rule ${r.ruleIndex}` : ""})  members ${list(r.members)}  requires ${list(r.requires)}`,
		table(
			["runner", "online", "member", "missing", "free"],
			((r.runners ?? []) as Any[]).map((w) => [
				w.runner,
				w.online ? "yes" : "NO",
				w.member == null ? "open" : w.member ? "yes" : "NO",
				list(w.missing),
				w.free == null ? "?" : w.free ? "yes" : "NO",
			]),
		),
		(r.blockers ?? []).length
			? `  NOT OFFERED because:\n${(r.blockers as string[]).map((l) => `    - ${l}`).join("\n")}`
			: "  nothing blocks it: an idle runner on the queue should get it",
		"",
		"== timeline",
		...((x.timeline ?? []) as Any[]).map(
			(e) =>
				`  #${e.seq}  ${e.at}  ${e.op}  ${e.actor}${e.bead ? `  -> ${e.bead.status}${e.bead.assignee ? ` (${e.bead.assignee})` : ""}` : ""}`,
		),
		"",
		"== comments",
		...((x.comments ?? []) as Any[]).map(
			(c) => `  ${c.createdAt}  ${c.author}: ${c.text}`,
		),
	];
	return out.join("\n");
}
