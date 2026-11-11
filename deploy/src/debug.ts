/**
 * `bun deploy/dokploy.ts debug state [--json]`: the operator's read-only view
 * of a running Mastermind (GET <url>/api/debug/state, Bearer operator key).
 * The key is never printed.
 */

export type DebugArgs = { what: "state"; json: boolean };

export function parseDebugArgs(argv: string[]): DebugArgs | null {
	const json = argv.includes("--json");
	const rest = argv.filter((a) => a !== "--json");
	if (rest.length !== 1 || rest[0] !== "state") return null;
	return { what: "state", json };
}

export const DEBUG_USAGE =
	"usage: bun deploy/dokploy.ts debug state [--json]  (MASTERMIND_URL + MASTERMIND_OPERATOR_KEY from env, else the app env in Dokploy)";

export async function fetchDebug(
	url: string,
	key: string,
	path: string,
	fetcher: typeof fetch = fetch,
): Promise<unknown> {
	const res = await fetcher(`${url.replace(/\/$/, "")}/api/debug/${path}`, {
		headers: { authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(20_000),
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
				r.serviceAccount ?? "-",
			]),
		),
	);
	section("routing", s.routing, (v) => {
		const doc = v.doc ?? {};
		const lines = [`  revision ${v.revision}`];
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
