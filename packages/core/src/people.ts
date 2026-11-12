/**
 * People: accounts (humans) and the runners they bring. Shapes of
 * `GET /api/accounts`, `GET /api/runners`, `GET /api/people/setup` and the
 * `runners` event of `GET /api/people/events`, shared by the api and the web UI.
 */

import type { RunnerReadiness } from "./dispatch.ts";

/** An account (a human). */
export type AccountView = {
	id: string;
	/** The name in the case the person typed it (`Lagz0ne`); absent = the id. */
	displayName?: string;
	createdAt: string;
	/** The account that invited it; null for the first account. */
	invitedBy: string | null;
};

/** A service account as listed on /people (never the secret). */
export type ServiceAccountRef = { id: string; name: string; createdAt: string };

/**
 * One row of the runner list: a runner the dispatcher heard from, or an
 * enrolled service account that never connected (`runner` null).
 */
export type RunnerView = {
	account: string;
	/** The service account; null when auth is off (local dev). */
	serviceAccount: ServiceAccountRef | null;
	/** The runner id (actor `<account>/<runner>`); null until it connects. */
	runner: string | null;
	/** Heard from within the online window. */
	online: boolean;
	lastSeenAt: string | null;
	/** Queues it asks for work on. */
	queues: string[];
	capabilities: string[];
	providers: string[];
	/** Agents at once; "unlimited"; null when the runner does not say. */
	capacity: number | "unlimited" | null;
	/** Ids of the beads its agents hold now. */
	running: string[];
	version: string | null;
	/**
	 * Worker readiness from the runner's last status (mm-210.59); null: it
	 * reports none (not connected, or older than mm-210.59).
	 */
	readiness?: RunnerReadiness | null;
};

export type AccountsReply = { accounts: AccountView[] };
export type RunnersReply = {
	runners: RunnerView[];
	/** The server's commit; a runner with another `version` is out of date. */
	serverVersion?: string;
};

/**
 * Public state for the login page. `auth`: `on` (sessions), `off`
 * (AUTH_DISABLED=1, local dev), `unconfigured` (API refuses), `starting`.
 * `firstLogin`: no account exists yet, so the server log holds the single-use
 * login URL of the first account.
 */
export type PeopleSetup = {
	auth: "on" | "off" | "unconfigured" | "starting";
	firstLogin: boolean;
};

/** Who the session is (`GET /api/people/me`). */
export type Me = { account: string; auth: "on" | "off" };
