/**
 * Browser side: web vitals, uncaught errors and route timings, batched and posted to
 * /api/telemetry (the browser cannot reach the OTLP collector). No dependencies.
 *
 * Vitals are measured with PerformanceObserver: TTFB, FCP, LCP, CLS (sum of shifts
 * without recent input) and INP (approximated as the slowest interaction). LCP, CLS
 * and INP are final when the page is first hidden, so they are sent then.
 */
import { type BrowserEvent, MAX_EVENTS } from "./events.ts";

export type { BrowserEvent } from "./events.ts";

/** The part of a TanStack Router we use; other routers can adapt to it. */
export type RouterLike = {
	subscribe(
		event: "onBeforeNavigate" | "onResolved",
		fn: (e: { toLocation: { pathname: string } }) => void,
	): () => void;
};

export type BrowserTelemetry = {
	push(event: BrowserEvent): void;
	/** Send queued events now. `beacon` uses sendBeacon (survives page unload). */
	flush(beacon?: boolean): void;
	/** Time each navigation, from start to resolved. Returns an unsubscribe. */
	trackRouter(router: RouterLike): () => void;
	stop(): void;
};

export type QueueOptions = {
	send: (body: string, beacon: boolean) => void;
	maxErrors?: number;
};

/** The batching core, without DOM listeners (testable on its own). */
export function createQueue(options: QueueOptions) {
	let queue: BrowserEvent[] = [];
	let errors = 0;
	const maxErrors = options.maxErrors ?? 20;
	return {
		push(event: BrowserEvent) {
			if (event.type === "error" && ++errors > maxErrors) return;
			queue.push(event);
		},
		flush(beacon = false) {
			while (queue.length) {
				const batch = queue.slice(0, MAX_EVENTS);
				queue = queue.slice(MAX_EVENTS);
				options.send(JSON.stringify({ events: batch }), beacon);
			}
		},
		get size() {
			return queue.length;
		},
	};
}

const path = () => location.pathname;

function post(url: string) {
	return (body: string, beacon: boolean) => {
		try {
			if (
				beacon &&
				navigator.sendBeacon?.(
					url,
					new Blob([body], { type: "application/json" }),
				)
			)
				return;
			void fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				keepalive: true,
			}).catch(() => {});
		} catch {
			// Telemetry must never break the page.
		}
	};
}

export function startBrowserTelemetry(
	options: { url?: string; intervalMs?: number } = {},
): BrowserTelemetry {
	const q = createQueue({ send: post(options.url ?? "/api/telemetry") });
	const cleanup: (() => void)[] = [];
	const vital = (name: "TTFB" | "FCP" | "LCP" | "CLS" | "INP", value: number) =>
		q.push({ type: "vital", name, value, path: path() });

	const supported = (type: string) =>
		typeof PerformanceObserver !== "undefined" &&
		PerformanceObserver.supportedEntryTypes?.includes(type);
	const observe = (
		type: string,
		fn: (entries: PerformanceEntry[]) => void,
		extra: object = {},
	) => {
		if (!supported(type)) return;
		try {
			const po = new PerformanceObserver((list) => fn(list.getEntries()));
			po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
			cleanup.push(() => po.disconnect());
		} catch {
			// Unsupported option or entry type: skip this vital.
		}
	};

	const nav = performance.getEntriesByType?.("navigation")[0] as
		| PerformanceNavigationTiming
		| undefined;
	if (nav && nav.responseStart > 0) vital("TTFB", nav.responseStart);

	observe("paint", (entries) => {
		for (const e of entries)
			if (e.name === "first-contentful-paint") vital("FCP", e.startTime);
	});
	let lcp: number | undefined;
	observe("largest-contentful-paint", (entries) => {
		const last = entries.at(-1);
		if (last) lcp = last.startTime;
	});
	let cls = 0;
	let shifted = false;
	observe("layout-shift", (entries) => {
		for (const e of entries as (PerformanceEntry & {
			value: number;
			hadRecentInput: boolean;
		})[]) {
			if (e.hadRecentInput) continue;
			cls += e.value;
			shifted = true;
		}
	});
	let inp: number | undefined;
	observe(
		"event",
		(entries) => {
			for (const e of entries as (PerformanceEntry & {
				interactionId?: number;
			})[])
				if (e.interactionId && (inp === undefined || e.duration > inp))
					inp = e.duration;
		},
		{ durationThreshold: 40 },
	);

	let finalSent = false;
	const onHidden = () => {
		if (!finalSent) {
			finalSent = true;
			if (lcp !== undefined) vital("LCP", lcp);
			if (shifted || supported("layout-shift")) vital("CLS", cls);
			if (inp !== undefined) vital("INP", inp);
		}
		q.flush(true);
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") onHidden();
	};
	const onError = (e: ErrorEvent) =>
		q.push({
			type: "error",
			message: e.message || String(e.error),
			stack: e.error instanceof Error ? e.error.stack : undefined,
			source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
			path: path(),
		});
	const onRejection = (e: PromiseRejectionEvent) =>
		q.push({
			type: "error",
			message: `unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`,
			stack: e.reason instanceof Error ? e.reason.stack : undefined,
			path: path(),
		});
	addEventListener("visibilitychange", onVisibility);
	addEventListener("pagehide", onHidden);
	addEventListener("error", onError);
	addEventListener("unhandledrejection", onRejection);
	cleanup.push(() => {
		removeEventListener("visibilitychange", onVisibility);
		removeEventListener("pagehide", onHidden);
		removeEventListener("error", onError);
		removeEventListener("unhandledrejection", onRejection);
	});

	const timer = setInterval(
		() => q.size && q.flush(),
		options.intervalMs ?? 10_000,
	);
	cleanup.push(() => clearInterval(timer));

	return {
		push: q.push,
		flush: q.flush,
		trackRouter: (router) => trackRouter(router, q.push),
		stop() {
			for (const fn of cleanup.splice(0)) fn();
		},
	};
}

/** Route timings: navigation start to resolved, per path. Exported for tests. */
export function trackRouter(
	router: RouterLike,
	push: (event: BrowserEvent) => void,
	now: () => number = () => performance.now(),
): () => void {
	let started: number | undefined;
	const offStart = router.subscribe("onBeforeNavigate", () => {
		started = now();
	});
	const offEnd = router.subscribe("onResolved", (e) => {
		if (started === undefined) return;
		push({ type: "route", path: e.toLocation.pathname, ms: now() - started });
		started = undefined;
	});
	return () => {
		offStart();
		offEnd();
	};
}
