/**
 * GET /api/debug/state: one read-only snapshot of the process for the
 * operator. Each section is read on its own with a timeout: a slow or broken
 * source gives `{ error }` in its place, never a failed snapshot.
 * No secret is in it: service accounts are views (no hash), log lines are
 * redacted.
 */
import { type Bead, columnOf, leaseState, queueOf } from "@mastermind/core";
import type { Account, ServiceAccountView } from "../auth/service.ts";
import type { DispatcherDebug } from "../dispatch/dispatcher.ts";
import type { RunnerEntry } from "../people/registry.ts";
import type { ConnectionView } from "./connections.ts";
import type { LogLine } from "./log-ring.ts";

export type DebugSources = {
	version: string;
	startedAt: Date;
	connections?: () => ConnectionView[];
	/** Null while auth is starting or off. */
	auth?: () => {
		accounts(): Promise<Account[]>;
		serviceAccounts(): Promise<ServiceAccountView[]>;
	} | null;
	runners?: () => RunnerEntry[];
	routing?: () => { read(): Promise<unknown> } | null;
	environments?: () => { read(): Promise<unknown> } | null;
	/** Every item on the board (open, claimed, recently closed). */
	items?: (() => Promise<Bead[]>) | null;
	errors?: () => LogLine[];
	/** Waiters and recent decisions of this replica's dispatcher; null while it starts. */
	dispatcher?: () => DispatcherDebug | null;
	now?: () => Date;
	/** Per section. Default 5 s. */
	timeoutMs?: number;
};

export type Section<T> = T | { error: string };

async function section<T>(
	read: () => Promise<T> | T,
	timeoutMs: number,
): Promise<Section<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(read),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

const off = (what: string) => {
	throw new Error(`${what} is off or starting`);
};

/** Counts per column, unrouted open items, claimed items with holder and lease. */
export function summarizeItems(items: Bead[], now: Date) {
	const columns: Record<string, number> = {};
	const statuses: Record<string, number> = {};
	const unrouted: string[] = [];
	const claimed: {
		id: string;
		title: string;
		status: string;
		queue: string | null;
		holder: string | null;
		leaseExpiresAt: string | null;
		heartbeatAt: string | null;
		lease: string;
	}[] = [];
	for (const b of items) {
		const column = columnOf(b) ?? "parked";
		columns[column] = (columns[column] ?? 0) + 1;
		statuses[b.status] = (statuses[b.status] ?? 0) + 1;
		const queue = queueOf(b);
		if (b.status === "open" && !queue) unrouted.push(b.id);
		if (b.assignee || b.lease)
			claimed.push({
				id: b.id,
				title: b.title,
				status: b.status,
				queue,
				holder: b.assignee ?? null,
				leaseExpiresAt: b.lease?.expiresAt ?? null,
				heartbeatAt: b.lease?.heartbeatAt ?? null,
				lease: leaseState(b.lease, now),
			});
	}
	const queues: Record<string, number> = {};
	for (const b of items)
		if (b.status === "open" && !b.blocked) {
			const q = queueOf(b) ?? "(none)";
			queues[q] = (queues[q] ?? 0) + 1;
		}
	return {
		total: items.length,
		columns,
		statuses,
		readyPerQueue: queues,
		unrouted,
		claimed: claimed.filter((c) => c.status !== "closed"),
	};
}

export async function debugState(src: DebugSources) {
	const now = (src.now ?? (() => new Date()))();
	const t = src.timeoutMs ?? 5_000;
	const auth = () => src.auth?.() ?? off("auth");
	const [accounts, serviceAccounts, routing, environments, items, dispatcher] =
		await Promise.all([
			section(
				async () =>
					(await auth().accounts()).map((a) => ({
						id: a.id,
						createdAt: a.createdAt,
						invitedBy: a.invitedBy,
					})),
				t,
			),
			section(
				async () =>
					(await auth().serviceAccounts()).map((s) => ({
						id: s.id,
						account: s.account,
						name: s.name,
						createdAt: s.createdAt,
					})),
				t,
			),
			section(() => (src.routing?.() ?? off("routing")).read(), t),
			section(() => (src.environments?.() ?? off("environments")).read(), t),
			section(async () => {
				if (!src.items) off("the work store");
				return summarizeItems(
					await (src.items as () => Promise<Bead[]>)(),
					now,
				);
			}, t),
			section(() => src.dispatcher?.() ?? off("the dispatcher"), t),
		]);
	return {
		version: src.version,
		now: now.toISOString(),
		startedAt: src.startedAt.toISOString(),
		uptimeSeconds: Math.round((now.getTime() - src.startedAt.getTime()) / 1000),
		nats: src.connections?.() ?? [],
		accounts,
		serviceAccounts,
		runners: src.runners?.() ?? [],
		routing,
		environments,
		items,
		dispatcher,
		errors: src.errors?.() ?? [],
	};
}

export type DebugState = Awaited<ReturnType<typeof debugState>>;
