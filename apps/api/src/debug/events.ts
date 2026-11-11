/**
 * GET /api/debug/events?since=<seq>[&follow=1]: work events, runner registry
 * changes and error lines in one place. Without `follow`: one JSON page.
 * With `follow`: Server-Sent Events (`work`, `runner`, `error`), first the
 * work backlog after `since`, then live.
 */
import type { BeadEvent } from "@mastermind/core";
import type { RunnerEntry } from "../people/registry.ts";
import type { LogLine } from "./log-ring.ts";

export type EventSources = {
	journalSince?: ((seq: number) => Promise<BeadEvent[]>) | null;
	/** Live work events (the board's journal hub); null without a work store. */
	hub?: () => {
		subscribe(listener: (event: BeadEvent) => void): {
			position: Promise<number>;
			unsubscribe(): void;
		};
	} | null;
	runners?: {
		list(): RunnerEntry[];
		subscribe(listener: () => void): () => void;
	};
	errors?: {
		lines(): LogLine[];
		subscribe(listener: (line: LogLine) => void): () => void;
	};
	/** Runner online/offline is a function of time: re-check this often. Default 5 s. */
	runnerCheckMs?: number;
	keepAliveMs?: number;
};

/** A work event without the full item: enough to follow what happens. */
export function workLine(e: BeadEvent) {
	return {
		seq: e.seq,
		at: e.at,
		op: e.op,
		item: e.beadId,
		actor: e.actor,
		status: e.bead?.status ?? null,
		assignee: e.bead?.assignee ?? null,
		queue: e.bead?.labels.find((l) => l.startsWith("queue:"))?.slice(6) ?? null,
		comment: e.comment ? e.comment.text.slice(0, 200) : undefined,
	};
}

type Diag = {
	state?: unknown;
	reconnects?: unknown;
	natsServer?: unknown;
	lastNextResult?: unknown;
	lastErrors?: unknown[];
};

/** What counts as a change of a runner (not lastSeenAt, which moves on every poll). */
export function runnerKey(r: RunnerEntry): string {
	const d = (r as RunnerEntry & { diagnostics?: Diag | null }).diagnostics;
	return JSON.stringify([
		r.online,
		r.queues,
		r.running,
		r.version,
		r.capacity,
		d
			? [
					d.state,
					d.reconnects,
					d.natsServer,
					d.lastNextResult,
					d.lastErrors?.length,
				]
			: null,
	]);
}

export function runnerLine(r: RunnerEntry) {
	const d = (r as RunnerEntry & { diagnostics?: Diag | null }).diagnostics;
	return {
		runner: `${r.account}/${r.runner}`,
		online: r.online,
		lastSeenAt: r.lastSeenAt,
		queues: r.queues,
		running: r.running,
		version: r.version,
		state: d?.state ?? null,
		reconnects: d?.reconnects ?? null,
		lastError: d?.lastErrors?.at(-1) ?? null,
	};
}

/** One JSON page: work events after `since` (one journal page), runners, errors. */
export async function eventsPage(src: EventSources, since: number) {
	const work = src.journalSince ? await src.journalSince(since) : [];
	return {
		since,
		next: work.at(-1)?.seq ?? since,
		work: work.map(workLine),
		runners: (src.runners?.list() ?? []).map(runnerLine),
		errors: src.errors?.lines() ?? [],
	};
}

/** The SSE stream. */
export function eventsStream(
	src: EventSources,
	since: number,
	signal: AbortSignal,
): Response {
	const enc = new TextEncoder();
	const cleanup: (() => void)[] = [];
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const send = (event: string, data: unknown) => {
				if (!open) return;
				try {
					controller.enqueue(
						enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					close();
				}
			};
			const close = () => {
				if (!open) return;
				open = false;
				for (const c of cleanup) c();
				try {
					controller.close();
				} catch {}
			};
			signal.addEventListener("abort", close);

			// Runners: the current list, then each change.
			const known = new Map<string, string>();
			const checkRunners = () => {
				const now = new Set<string>();
				for (const r of src.runners?.list() ?? []) {
					const id = `${r.account}/${r.runner}`;
					now.add(id);
					const k = runnerKey(r);
					if (known.get(id) !== k) {
						known.set(id, k);
						send("runner", runnerLine(r));
					}
				}
				for (const id of known.keys())
					if (!now.has(id)) {
						known.delete(id);
						send("runner", { runner: id, gone: true });
					}
			};
			if (src.runners) {
				checkRunners();
				cleanup.push(src.runners.subscribe(checkRunners));
				const t = setInterval(checkRunners, src.runnerCheckMs ?? 5_000);
				cleanup.push(() => clearInterval(t));
			}
			if (src.errors)
				cleanup.push(src.errors.subscribe((line) => send("error", line)));
			const ka = setInterval(() => {
				if (!open) return;
				try {
					controller.enqueue(enc.encode(": keep-alive\n\n"));
				} catch {
					close();
				}
			}, src.keepAliveMs ?? 8_000);
			cleanup.push(() => clearInterval(ka));

			// Work: subscribe first, then the backlog up to the hub's position.
			const hub = src.hub?.() ?? null;
			if (!hub || !src.journalSince) {
				send("info", { work: "the work store is off or starting" });
				return;
			}
			const live: BeadEvent[] = [];
			let replaying = true;
			let last = since;
			const emit = (e: BeadEvent) => {
				if (e.seq <= last) return;
				last = e.seq;
				send("work", workLine(e));
			};
			const sub = hub.subscribe((e) => (replaying ? live.push(e) : emit(e)));
			cleanup.push(() => sub.unsubscribe());
			try {
				const position = await sub.position;
				let cursor = since;
				for (let pages = 0; cursor < position && pages < 50 && open; pages++) {
					const page = await src.journalSince(cursor);
					if (!page.length) break;
					for (const e of page) if (e.seq <= position) emit(e);
					cursor = page.at(-1)?.seq ?? position;
				}
			} catch (error) {
				send("info", { work: `backlog failed: ${String(error)}` });
			}
			replaying = false;
			for (const e of live.splice(0)) emit(e);
		},
		cancel() {
			for (const c of cleanup) c();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			"x-accel-buffering": "no",
		},
	});
}
