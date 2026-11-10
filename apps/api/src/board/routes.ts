// GET /api/board (snapshot) and GET /api/events (SSE), both read from the work store.
import {
	type Bead,
	type BeadEvent,
	BOARD_COLUMNS,
	type BoardSnapshot,
} from "@mastermind/core";
import type { Server } from "bun";
import { type HubOptions, JournalHub } from "./hub.ts";
import { type LeaseChange, type LeaseSource, LeaseWatch } from "./leases.ts";
import type { JournalSource } from "./tail.ts";

/** What the board routes read. The NATS work store in production (natsBoardSource). */
export type BoardSource = JournalSource &
	Partial<LeaseSource> & {
		board(): Promise<Bead[]>;
		/** Highest journal seq, 0 when the journal is empty. */
		head(): Promise<number>;
	};

export type BoardRoutesOptions = Omit<HubOptions, "head"> & {
	/** SSE comment sent this often so proxies keep the stream open. Default 8 s. */
	keepAliveMs?: number;
	/** Poll interval of the leases table (heartbeats). Default 2 s. */
	leaseIntervalMs?: number;
};

type Handler = (req: Request, server?: Server<unknown>) => Promise<Response>;

export type BoardRoutes = {
	routes: { "/api/board": Handler; "/api/events": Handler };
	/** The shared journal tail; null without a work store. */
	hub: JournalHub | null;
	stop(): void;
};

const unconfigured = () =>
	Response.json(
		{
			error: "work unconfigured",
			detail: "Set NATS (auth or DISPATCH_NATS_URL) to serve the board.",
		},
		{ status: 503 },
	);

const unavailable = (error: unknown) =>
	Response.json(
		{ error: "work unavailable", detail: String(error) },
		{ status: 503 },
	);

/** Parse a non-negative integer cursor; null when absent or invalid. */
export function parseSeq(raw: string | null | undefined): number | null {
	if (raw == null || !/^\d+$/.test(raw.trim())) return null;
	return Number(raw.trim());
}

const encoder = new TextEncoder();

export function sseFrame(event: BeadEvent): Uint8Array {
	return encoder.encode(
		`id: ${event.seq}\nevent: bead\ndata: ${JSON.stringify(event)}\n\n`,
	);
}

/** A lease change: no id, so it never moves the client's Last-Event-ID. */
export function leaseFrame(change: LeaseChange): Uint8Array {
	return encoder.encode(`event: lease\ndata: ${JSON.stringify(change)}\n\n`);
}

/**
 * Routes for Bun.serve. With a null source (no work store) both answer 503 and
 * nothing else changes, so the app stays deployable without NATS.
 */
export function boardRoutes(
	source: BoardSource | null,
	options: BoardRoutesOptions = {},
): BoardRoutes {
	if (!source) {
		return {
			routes: {
				"/api/board": async () => unconfigured(),
				"/api/events": async () => unconfigured(),
			},
			hub: null,
			stop() {},
		};
	}
	const src = source;
	const { keepAliveMs = 8_000, leaseIntervalMs, ...hubOptions } = options;
	const hub = new JournalHub(src, { ...hubOptions, head: () => src.head() });
	const leasesOf = src.leases?.bind(src);
	const leases = leasesOf
		? new LeaseWatch(
				{ leases: leasesOf },
				{ intervalMs: leaseIntervalMs, onError: hubOptions.onError },
			)
		: null;

	async function board(req: Request): Promise<Response> {
		try {
			// Head first, then beads: the snapshot is at least as new as `seq`,
			// and replaying events after `seq` is idempotent (each carries the
			// whole bead), so nothing between the two reads is lost.
			const seq = await src.head();
			const etag = `"${seq}"`;
			const headers = { etag, "cache-control": "no-cache" };
			if (req.headers.get("if-none-match") === etag) {
				return new Response(null, { status: 304, headers });
			}
			const body: BoardSnapshot = {
				columns: BOARD_COLUMNS,
				beads: await src.board(),
				seq,
			};
			return Response.json(body, { headers });
		} catch (error) {
			return unavailable(error);
		}
	}

	async function events(
		req: Request,
		server?: Server<unknown>,
	): Promise<Response> {
		// EventSource sends Last-Event-ID on reconnect; it wins over ?since.
		const since =
			parseSeq(req.headers.get("last-event-id")) ??
			parseSeq(new URL(req.url).searchParams.get("since"));
		// Bun closes idle connections after 10 s by default; a stream must not idle out.
		server?.timeout(req, 0);

		let cleanup = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let last = since ?? 0;
				let closed = false;
				const send = (event: BeadEvent) => {
					if (closed || event.seq <= last) return;
					last = event.seq;
					controller.enqueue(sseFrame(event));
				};
				const close = () => {
					cleanup();
					try {
						controller.close();
					} catch {}
				};
				// Live events wait here until the backlog has been sent.
				let pending: BeadEvent[] | null = [];
				const subscription = hub.subscribe((event) => {
					if (pending) pending.push(event);
					else send(event);
				});
				const unwatch = leases?.subscribe((change) => {
					if (!closed) controller.enqueue(leaseFrame(change));
				});
				const keepAlive = setInterval(() => {
					if (!closed) controller.enqueue(encoder.encode(": ka\n\n"));
				}, keepAliveMs);
				cleanup = () => {
					if (closed) return;
					closed = true;
					clearInterval(keepAlive);
					subscription.unsubscribe();
					unwatch?.();
				};
				req.signal.addEventListener("abort", close);
				controller.enqueue(encoder.encode("retry: 2000\n\n"));

				void (async () => {
					try {
						// Everything after `position` comes live from the hub; read
						// the backlog (last, position] from the journal.
						const position = await subscription.position;
						if (since === null) last = Math.max(last, position);
						while (!closed && last < position) {
							const page = await src.journalSince(last);
							const fresh = page.filter((e) => e.seq > last);
							if (fresh.length === 0) break;
							for (const event of fresh.sort((a, b) => a.seq - b.seq)) {
								send(event);
							}
						}
					} catch (error) {
						hubOptions.onError?.(error);
						// The client reconnects with Last-Event-ID and resumes.
						return close();
					}
					const queued = pending ?? [];
					pending = null;
					for (const event of queued) send(event);
				})();
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	}

	return {
		routes: { "/api/board": board, "/api/events": events },
		hub,
		stop: () => {
			hub.stop();
			leases?.stop();
		},
	};
}
