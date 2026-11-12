/**
 * /people data: accounts, the live runner list, and the writes (approve a login, add a
 * runner, revoke) that go to /api/auth.
 */
import {
	type AccountsReply,
	type AccountView,
	type RunnersReply,
	type RunnerView,
	runnerVersionNotice,
} from "@mastermind/core";
import { useEffect, useState } from "react";
import { send } from "../session/session.ts";

export type PeopleStatus = "loading" | "live" | "reconnecting" | "offline";

export type People = {
	accounts: AccountView[];
	runners: RunnerView[];
	/** The server's commit (runners on another one are out of date). */
	serverVersion?: string;
	status: PeopleStatus;
	error?: string;
	/** Read accounts and runners again (after an invite or a revoke). */
	reload: () => void;
};

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path, { credentials: "same-origin" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(body?.error ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

/** GET /api/accounts and /api/runners, then follow GET /api/people/events. */
export function usePeople(): People {
	const [state, setState] = useState<Omit<People, "reload">>({
		accounts: [],
		runners: [],
		status: "loading",
	});
	const [generation, setGeneration] = useState(0);

	useEffect(() => {
		let cancelled = false;
		let source: EventSource | null = null;
		void generation;
		Promise.all([
			getJson<AccountsReply>("/api/accounts"),
			getJson<RunnersReply>("/api/runners"),
		])
			.then(([a, r]) => {
				if (cancelled) return;
				setState({
					accounts: a.accounts,
					runners: r.runners,
					serverVersion: r.serverVersion,
					status: "live",
				});
				source = new EventSource("/api/people/events");
				source.addEventListener("runners", (m) => {
					const { runners, serverVersion } = JSON.parse(m.data) as RunnersReply;
					setState((s) => ({ ...s, runners, serverVersion, status: "live" }));
				});
				source.addEventListener("open", () =>
					setState((s) => ({ ...s, status: "live" })),
				);
				source.addEventListener("error", () =>
					setState((s) => ({ ...s, status: "reconnecting" })),
				);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setState({
					accounts: [],
					runners: [],
					status: "offline",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
			source?.close();
		};
	}, [generation]);

	return { ...state, reload: () => setGeneration((g) => g + 1) };
}

/** One account and its runner rows, for the table. */
export type AccountGroup = {
	account: string;
	/** What to show: the display name, else the id. */
	name: string;
	invitedBy: string | null;
	createdAt: string | null;
	runners: RunnerView[];
};

/** Accounts in list order, each with its runners; runners of unknown accounts last. */
export function groupByAccount(
	accounts: AccountView[],
	runners: RunnerView[],
): AccountGroup[] {
	const groups = new Map<string, AccountGroup>();
	for (const a of accounts)
		groups.set(a.id, {
			account: a.id,
			name: a.displayName ?? a.id,
			invitedBy: a.invitedBy,
			createdAt: a.createdAt || null,
			runners: [],
		});
	for (const r of runners) {
		let g = groups.get(r.account);
		if (!g) {
			g = {
				account: r.account,
				name: r.account,
				invitedBy: null,
				createdAt: null,
				runners: [],
			};
			groups.set(r.account, g);
		}
		g.runners.push(r);
	}
	return [...groups.values()];
}

export type PeopleStats = {
	accounts: number;
	online: number;
	runners: number;
	busy: number;
	/** null: a runner has unlimited capacity. */
	slots: number | null;
};

export function statsOf(groups: AccountGroup[]): PeopleStats {
	const rows = groups.flatMap((g) => g.runners).filter((r) => r.runner);
	return {
		accounts: groups.length,
		runners: rows.length,
		online: rows.filter((r) => r.online).length,
		busy: rows.reduce((n, r) => n + r.running.length, 0),
		slots: rows.some((r) => r.capacity === "unlimited")
			? null
			: rows.reduce(
					(n, r) => n + (typeof r.capacity === "number" ? r.capacity : 0),
					0,
				),
	};
}

/** "3 s ago", "14 min ago", "2 h ago"; "never" without a time. */
export function ago(iso: string | null, now: number): string {
	if (!iso) return "never";
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	return `${Math.round(m / 60)} h ago`;
}

/** Single-quote a shell word unless it is plainly safe. */
function sh(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;
}

/** Where /install.sh puts the runner (its default MASTERMIND_RUNNER_DIR). */
export const RUNNER_BIN = "~/.local/bin/mastermind-runner";

/**
 * The ONE command a machine runs to install the runner (a compiled binary of
 * this server's commit, sha256-checked) and onboard it: local checks, enrol
 * with the single-use token, missing secrets, doctor --deep, READY, then start
 * (mm-210.59). Needs no clone and no bun; the agents need a running Paseo
 * daemon and a provider that is logged in.
 */
export function runnerCommand(
	origin: string,
	token: string,
	queue: string,
): string {
	return [
		`curl -fsSL ${sh(`${origin}/install.sh`)} | sh`,
		`${RUNNER_BIN} onboard ${sh(token)} --url ${sh(origin)} --queue ${sh(queue)} --workdir . --start`,
	].join(" && ");
}

/**
 * What the runner's Paseo reports (mm-210.84), short: the ready providers
 * with their default mode, a logged-out one, and how many others are not
 * ready. `title`: every provider. Null: no report.
 */
export function paseoOf(
	r: Pick<RunnerView, "paseo">,
): { text: string; title: string; bad: boolean } | null {
	if (!r.paseo) return null;
	const one = (p: NonNullable<RunnerView["paseo"]>[number]) => {
		if (p.loggedIn === false) return `${p.name} not logged in`;
		if (!p.enabled) return `${p.name} disabled`;
		if (p.status !== "ready")
			return `${p.name} ${p.status}${p.error ? ` (${p.error})` : ""}`;
		return `${p.name} ready${p.defaultMode ? `, mode ${p.defaultMode}` : ""}`;
	};
	const ok = (p: NonNullable<RunnerView["paseo"]>[number]) =>
		p.enabled && p.status === "ready" && p.loggedIn !== false;
	const ready = r.paseo.filter(ok);
	const loggedOut = r.paseo.filter((p) => p.loggedIn === false);
	const rest = r.paseo.length - ready.length - loggedOut.length;
	const parts = [...ready, ...loggedOut].map(one);
	if (rest > 0) parts.push(`${rest} more not ready`);
	return {
		text: `Paseo: ${parts.join(" · ") || "no provider"}`,
		title: r.paseo.map(one).join("\n"),
		bad: ready.length === 0,
	};
}

/**
 * The state cell and the lines under a runner's name (mm-210.59): offline,
 * enrolled (never connected), or its readiness and the failed checks. A
 * connected runner that reports no readiness gets no work: say so. Its
 * service account not seen for 7 days is stale; after 14 days disabled
 * (mm-210.66).
 */
export function readinessOf(r: RunnerView): {
	state: string;
	/** Not `ready` (or not connected): shown as a problem. */
	bad: boolean;
	lines: { text: string; bad: boolean }[];
} {
	const sa = r.serviceAccount;
	if (sa?.state === "disabled")
		return {
			state: "disabled",
			bad: true,
			lines: [
				{
					text: "not seen for 14 days: its credential is refused — fix: revoke it, then add the runner again",
					bad: true,
				},
			],
		};
	if (sa?.state === "stale" && !r.online)
		return {
			state: "stale",
			bad: true,
			lines: [
				{
					text: "not seen for 7 days: disabled after 14 — fix: start the runner",
					bad: true,
				},
			],
		};
	if (!r.runner) return { state: "enrolled", bad: false, lines: [] };
	if (!r.online) return { state: "offline", bad: true, lines: [] };
	const x = r.readiness;
	if (!x)
		return {
			state: "not ready",
			bad: true,
			lines: [
				{
					text: "it does not report readiness — fix: install it again, then mastermind-runner onboard",
					bad: true,
				},
			],
		};
	return {
		state: x.state,
		bad: x.state !== "ready",
		lines: x.failedChecks.map((c) => ({
			text: `${c.environment ? `${c.environment}: ` : ""}${c.problem}${c.fix ? ` — fix: ${c.fix}` : ""}`,
			// A failed environment check of a ready runner: only that environment waits.
			bad: !c.environment || x.state !== "ready",
		})),
	};
}

/**
 * A connected runner on another commit than the server's: the one notice
 * (core runnerVersionNotice, mm-210.77); null: up to date, run from source,
 * or no server version.
 */
export function outdatedNotice(
	r: RunnerView,
	serverVersion?: string,
): string | null {
	if (!r.runner || !serverVersion) return null;
	return runnerVersionNotice(r.version ?? "unknown", serverVersion);
}

/** The runner reports a commit other than the server's: update it. */
export function outdated(r: RunnerView, serverVersion?: string): boolean {
	return outdatedNotice(r, serverVersion) !== null;
}

/** What the approver sees after an approval, to spot a stranger's code. */
export type LoginApproval = {
	account: string;
	created: boolean;
	ageSeconds: number;
	userAgent: string;
};

/**
 * POST /api/auth/login/approve: approve the code that a browser shows on
 * /login, for my own account (another device) or a new account (an invite).
 */
export function approveLogin(
	code: string,
	account: string,
): Promise<LoginApproval> {
	return send<LoginApproval>("POST", "/api/auth/login/approve", {
		code,
		account,
	});
}

/**
 * POST /api/auth/login/deny: refuse the code of a login I do not know. That
 * browser shows "denied" at its next poll.
 */
export async function denyLogin(code: string): Promise<void> {
	await send("POST", "/api/auth/login/deny", { code });
}

/** POST /api/auth/tokens {kind: enrol}: a single-use enrol token for a new runner. */
export async function enrolToken(name: string): Promise<string> {
	const r = await send<{ token: string }>("POST", "/api/auth/tokens", {
		kind: "enrol",
		name,
	});
	return r.token;
}

/** DELETE /api/auth/service-accounts/:id: the runner's NATS connection is closed. */
export async function revoke(serviceAccountId: string): Promise<void> {
	await send(
		"DELETE",
		`/api/auth/service-accounts/${encodeURIComponent(serviceAccountId)}`,
	);
}
