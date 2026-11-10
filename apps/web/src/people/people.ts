/**
 * /people data: accounts, the live runner list, and the writes (invite, add a
 * runner, revoke) that go to /api/auth.
 */
import type {
	AccountsReply,
	AccountView,
	RunnersReply,
	RunnerView,
} from "@mastermind/core";
import { useEffect, useState } from "react";
import { send } from "../session/session.ts";

export type PeopleStatus = "loading" | "live" | "reconnecting" | "offline";

export type People = {
	accounts: AccountView[];
	runners: RunnerView[];
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
				setState({ accounts: a.accounts, runners: r.runners, status: "live" });
				source = new EventSource("/api/people/events");
				source.addEventListener("runners", (m) => {
					const { runners } = JSON.parse(m.data) as RunnersReply;
					setState((s) => ({ ...s, runners, status: "live" }));
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
			invitedBy: a.invitedBy,
			createdAt: a.createdAt || null,
			runners: [],
		});
	for (const r of runners) {
		let g = groups.get(r.account);
		if (!g) {
			g = { account: r.account, invitedBy: null, createdAt: null, runners: [] };
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
	slots: number;
};

export function statsOf(groups: AccountGroup[]): PeopleStats {
	const rows = groups.flatMap((g) => g.runners).filter((r) => r.runner);
	return {
		accounts: groups.length,
		runners: rows.length,
		online: rows.filter((r) => r.online).length,
		busy: rows.reduce((n, r) => n + r.running.length, 0),
		slots: rows.reduce((n, r) => n + (r.capacity ?? 0), 0),
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

/**
 * The ONE command a machine runs to get the runner, enrol it with the
 * single-use token and start it. Needs bun and a running Paseo daemon.
 */
export function runnerCommand(
	origin: string,
	token: string,
	queue: string,
): string {
	const file = "mastermind-runner.js";
	return [
		`curl -fsSL ${sh(`${origin}/runner.js`)} -o ${file}`,
		`bun ${file} enroll ${sh(token)} --url ${sh(origin)} --queue ${sh(queue)} --workdir .`,
		`bun ${file} start`,
	].join(" && ");
}

/** POST /api/auth/tokens {kind: invite}: the single-use login URL for a new account. */
export async function invite(account: string): Promise<string> {
	const r = await send<{ url: string }>("POST", "/api/auth/tokens", {
		kind: "invite",
		account,
	});
	return r.url;
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
