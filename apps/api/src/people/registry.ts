/**
 * The runner registry: which runners this replica heard from, kept in memory.
 * The dispatcher's observe hook feeds it (`next` requests carry the
 * RunnerInfo; heartbeats and claims say which beads an actor holds).
 *
 * A runner is online while it was heard from within `onlineMs`: an idle runner
 * long-polls `next` (20 s), a full one heartbeats each bead (at most 60 s).
 * Entries not heard from for `forgetMs` are dropped. Runners also publish
 * their own diagnostics (`mm.u.<account>.r.<runner>.status`, every 15 s);
 * `listen` keeps the last one per runner.
 *
 * With more than one api replica, each one sees only the requests it served;
 * v0 runs one replica.
 */
import { parseSubject, patterns, subscribe } from "@mastermind/bus";
import type { RunnerDiagnostics, RunnerInfo } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import type { DispatchSeen } from "../dispatch/dispatcher.ts";

export type RunnerEntry = {
	account: string;
	runner: string;
	/** Service account id; null until a `next` request names it. */
	serviceAccount: string | null;
	queues: string[];
	capabilities: string[];
	providers: string[];
	/** "unlimited" when the runner says null; null when it does not say. */
	capacity: number | "unlimited" | null;
	version: string | null;
	running: string[];
	lastSeenAt: string;
	online: boolean;
	/** The last status the runner published about itself; null before one. */
	diagnostics: RunnerDiagnostics | null;
};

export type RegistryOptions = {
	/** Heard from within this: online. Default 90 s. */
	onlineMs?: number;
	/** Not heard from for this: dropped. Default 24 h. */
	forgetMs?: number;
	now?: () => Date;
};

type Entry = {
	account: string;
	runner: string;
	info: RunnerInfo | null;
	/** Queues seen in `next` subjects, besides the ones the runner states. */
	queues: Set<string>;
	running: Set<string>;
	lastSeen: number;
	diagnostics: RunnerDiagnostics | null;
};

/** `<account>/<runner>` → [account, runner]; null for other actors. */
function splitActor(actor: string): [string, string] | null {
	const i = actor.indexOf("/");
	if (i <= 0 || i === actor.length - 1) return null;
	return [actor.slice(0, i), actor.slice(i + 1)];
}

export class RunnerRegistry {
	readonly #entries = new Map<string, Entry>();
	readonly #listeners = new Set<() => void>();
	readonly #onlineMs: number;
	readonly #forgetMs: number;
	readonly #now: () => Date;

	constructor(options: RegistryOptions = {}) {
		this.#onlineMs = options.onlineMs ?? 90_000;
		this.#forgetMs = options.forgetMs ?? 24 * 60 * 60 * 1000;
		this.#now = options.now ?? (() => new Date());
	}

	/** Feed for the dispatcher's `observe` option. */
	readonly observe = (seen: DispatchSeen): void => {
		const now = this.#now().getTime();
		if (seen.kind === "next") {
			const e = this.#entry(seen.runner.account, seen.runner.id, now);
			e.info = seen.runner;
			e.queues.add(seen.queue);
		} else {
			const who = splitActor(seen.actor);
			if (!who) return;
			if (seen.kind === "holds") {
				this.#entry(who[0], who[1], now).running.add(seen.beadId);
			} else {
				// `done` may come from the sweep (a dead lease): not a sign of life.
				const e = this.#entries.get(seen.actor);
				if (!e?.running.delete(seen.beadId)) return;
			}
		}
		this.#changed();
	};

	/**
	 * Store a runner's own status. `account` comes from the subject (the auth
	 * callout scopes each service account to its account's prefix).
	 */
	status(account: string, d: RunnerDiagnostics): void {
		if (
			!d ||
			typeof d !== "object" ||
			typeof d.runner !== "string" ||
			!d.runner
		)
			return;
		const e = this.#entry(account, d.runner, this.#now().getTime());
		e.diagnostics = d;
		this.#changed();
	}

	/** Receive runner status messages on `nc`. Returns a stop function. */
	listen(nc: NatsConnection): () => void {
		const sub = subscribe<RunnerDiagnostics>(
			nc,
			patterns.runnerStatus,
			(d, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind === "runnerStatus") this.status(s.account, d);
			},
		);
		return () => sub.unsubscribe();
	}

	/** Drop every runner of a service account (it was revoked). */
	forgetServiceAccount(id: string): void {
		let dropped = false;
		for (const [key, e] of this.#entries) {
			if (e.info?.serviceAccount === id) {
				this.#entries.delete(key);
				dropped = true;
			}
		}
		if (dropped) this.#changed();
	}

	/** Every runner, by account then runner id. */
	list(): RunnerEntry[] {
		const now = this.#now().getTime();
		const out: RunnerEntry[] = [];
		for (const [key, e] of this.#entries) {
			if (now - e.lastSeen > this.#forgetMs) {
				this.#entries.delete(key);
				continue;
			}
			const stated = e.info?.queues ?? [];
			out.push({
				account: e.account,
				runner: e.runner,
				serviceAccount: e.info?.serviceAccount ?? null,
				queues: [...new Set([...stated, ...e.queues])].sort(),
				capabilities: e.info?.capabilities ?? [],
				providers: e.info?.providers ?? [],
				capacity:
					e.info?.capacity === null ? "unlimited" : (e.info?.capacity ?? null),
				version: e.info?.version ?? null,
				running: [...e.running].sort(),
				lastSeenAt: new Date(e.lastSeen).toISOString(),
				online: now - e.lastSeen <= this.#onlineMs,
				diagnostics: e.diagnostics,
			});
		}
		return out.sort(
			(a, b) =>
				a.account.localeCompare(b.account) || a.runner.localeCompare(b.runner),
		);
	}

	/** Called after every change (not on online → offline by time). */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#entry(account: string, runner: string, now: number): Entry {
		const key = `${account}/${runner}`;
		let e = this.#entries.get(key);
		if (!e) {
			e = {
				account,
				runner,
				info: null,
				queues: new Set(),
				running: new Set(),
				lastSeen: now,
				diagnostics: null,
			};
			this.#entries.set(key, e);
		}
		e.lastSeen = now;
		return e;
	}

	#changed(): void {
		for (const l of this.#listeners) {
			try {
				l();
			} catch {}
		}
	}
}
