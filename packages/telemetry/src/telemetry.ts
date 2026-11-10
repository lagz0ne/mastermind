/**
 * A small OTLP/HTTP (JSON) exporter on fetch: logs, spans and cumulative metrics,
 * buffered in memory and posted to `<endpoint>/v1/{logs,traces,metrics}` on an interval.
 * Without an endpoint it is a no-op, so call sites never check.
 */
import {
	type Attrs,
	type LogRecord,
	logsBody,
	type MetricRecord,
	metricsBody,
	resource,
	type Severity,
	type SpanKind,
	type SpanRecord,
	tracesBody,
} from "./otlp.ts";

export type { Attrs, Severity, SpanKind };

export type SpanContext = { traceId: string; spanId: string };

export interface Span extends SpanContext {
	/** Add or overwrite attributes before {@link Span.end}. */
	set(attrs: Attrs): void;
	/** End the span. Pass the error when the operation failed. Later calls do nothing. */
	end(error?: unknown): void;
}

export type SpanOptions = {
	attrs?: Attrs;
	parent?: SpanContext;
	kind?: SpanKind;
};

export type HistogramOptions = { unit?: string; bounds?: number[] };

export interface Telemetry {
	/** False for the no-op instance (no endpoint configured). */
	readonly enabled: boolean;
	log(
		severity: Severity,
		message: string,
		attrs?: Attrs,
		span?: SpanContext,
	): void;
	startSpan(name: string, options?: SpanOptions): Span;
	/** Run `fn` inside a span; the span ends (with the error, if any) when `fn` settles. */
	span<T>(
		name: string,
		fn: (span: Span) => T | Promise<T>,
		options?: SpanOptions,
	): Promise<T>;
	/** Add to a monotonic counter. */
	count(name: string, value?: number, attrs?: Attrs): void;
	/** Record one value in a histogram. Unit and bounds are fixed by the first call per name. */
	record(
		name: string,
		value: number,
		attrs?: Attrs,
		options?: HistogramOptions,
	): void;
	/** Post everything buffered now. Never throws. */
	flush(): Promise<void>;
	/** Stop the interval and flush one last time. */
	shutdown(): Promise<void>;
}

export type TelemetryOptions = {
	/** OTLP/HTTP base URL, e.g. http://otlp-ingest:4318. Unset or empty = no-op. */
	endpoint?: string;
	serviceName: string;
	serviceVersion?: string;
	/** Extra resource attributes. */
	attrs?: Attrs;
	/** Flush interval. 0 disables the timer (tests). Default 5000. */
	intervalMs?: number;
	/** Logs and spans kept per signal before the oldest are dropped. Default 5000. */
	maxQueue?: number;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	/** Export failures. Default: one console.error line per failure streak. */
	onError?: (error: unknown) => void;
};

/** Milliseconds; good for request and query durations. */
export const DURATION_BOUNDS = [
	5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

const hex = (bytes: number) => {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};
export const newTraceId = () => hex(16);
export const newSpanId = () => hex(8);

const NOOP_SPAN: Span = { traceId: "", spanId: "", set() {}, end() {} };

export const noopTelemetry: Telemetry = {
	enabled: false,
	log() {},
	startSpan: () => NOOP_SPAN,
	span: async (_name, fn) => fn(NOOP_SPAN),
	count() {},
	record() {},
	flush: async () => {},
	shutdown: async () => {},
};

/** Stable key for an attribute set: sorted, so {a,b} and {b,a} share a series. */
const seriesKey = (attrs: Attrs) =>
	JSON.stringify(
		Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

type Counter = {
	kind: "counter";
	unit?: string;
	series: Map<string, { attrs: Attrs; value: number }>;
};
type Histogram = {
	kind: "histogram";
	unit?: string;
	bounds: number[];
	series: Map<
		string,
		{ attrs: Attrs; count: number; sum: number; buckets: number[] }
	>;
};

export function createTelemetry(options: TelemetryOptions): Telemetry {
	const endpoint = options.endpoint?.trim().replace(/\/+$/, "");
	if (!endpoint) return noopTelemetry;

	const now = options.now ?? Date.now;
	const send = options.fetch ?? ((url, init) => fetch(url, init));
	const maxQueue = options.maxQueue ?? 5000;
	const res = resource({
		"service.name": options.serviceName,
		"service.version": options.serviceVersion,
		...options.attrs,
	});
	const started = now();

	let logs: LogRecord[] = [];
	let spans: SpanRecord[] = [];
	const metrics = new Map<string, Counter | Histogram>();
	let failing = false;
	const onError =
		options.onError ??
		((error: unknown) => {
			if (!failing)
				console.error(`telemetry: export to ${endpoint} failed: ${error}`);
		});

	const push = <T>(queue: T[], item: T) => {
		queue.push(item);
		if (queue.length > maxQueue) queue.shift();
	};

	const startSpan = (name: string, opts: SpanOptions = {}): Span => {
		const record: SpanRecord = {
			traceId: opts.parent?.traceId || newTraceId(),
			spanId: newSpanId(),
			parentSpanId: opts.parent?.spanId || undefined,
			name,
			kind: opts.kind ?? "internal",
			start: now(),
			end: 0,
			attrs: { ...opts.attrs },
		};
		let ended = false;
		return {
			traceId: record.traceId,
			spanId: record.spanId,
			set(attrs) {
				Object.assign(record.attrs ?? {}, attrs);
			},
			end(error) {
				if (ended) return;
				ended = true;
				record.end = now();
				if (error !== undefined)
					record.error = error instanceof Error ? error.message : String(error);
				push(spans, record);
			},
		};
	};

	const post = async (path: string, body: unknown) => {
		const r = await send(`${endpoint}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
	};

	const metricRecords = (): MetricRecord[] =>
		[...metrics].map(([name, m]) =>
			m.kind === "counter"
				? {
						kind: "counter",
						name,
						unit: m.unit,
						points: [...m.series.values()],
					}
				: {
						kind: "histogram",
						name,
						unit: m.unit,
						bounds: m.bounds,
						points: [...m.series.values()].map((p) => ({
							...p,
							buckets: [...p.buckets],
						})),
					},
		);

	let inflight: Promise<void> | null = null;
	const flush = (): Promise<void> => {
		// One export at a time; a flush during an export waits for it, then runs.
		const run = async () => {
			const batchLogs = logs;
			const batchSpans = spans;
			logs = [];
			spans = [];
			const jobs: Promise<void>[] = [];
			if (batchLogs.length)
				jobs.push(post("/v1/logs", logsBody(res, batchLogs)));
			if (batchSpans.length)
				jobs.push(post("/v1/traces", tracesBody(res, batchSpans)));
			if (metrics.size)
				jobs.push(
					post(
						"/v1/metrics",
						metricsBody(res, metricRecords(), started, now()),
					),
				);
			const results = await Promise.allSettled(jobs);
			const failed = results.find((r) => r.status === "rejected");
			if (failed) {
				onError(failed.reason);
				failing = true;
			} else failing = false;
		};
		const next = (inflight ?? Promise.resolve()).then(run, run);
		inflight = next;
		return next.finally(() => {
			if (inflight === next) inflight = null;
		});
	};

	const timer =
		options.intervalMs === 0
			? null
			: setInterval(() => void flush(), options.intervalMs ?? 5000);
	if (timer && typeof timer === "object" && "unref" in timer) timer.unref();

	return {
		enabled: true,
		log(severity, message, attrs, span) {
			push(logs, {
				time: now(),
				severity,
				message,
				attrs,
				traceId: span?.traceId || undefined,
				spanId: span?.spanId || undefined,
			});
		},
		startSpan,
		async span(name, fn, opts) {
			const s = startSpan(name, opts);
			try {
				const result = await fn(s);
				s.end();
				return result;
			} catch (error) {
				s.end(error);
				throw error;
			}
		},
		count(name, value = 1, attrs = {}) {
			let m = metrics.get(name);
			if (!m) {
				m = { kind: "counter", series: new Map() };
				metrics.set(name, m);
			}
			if (m.kind !== "counter") return;
			const key = seriesKey(attrs);
			const point = m.series.get(key);
			if (point) point.value += value;
			else m.series.set(key, { attrs, value });
		},
		record(name, value, attrs = {}, opts = {}) {
			if (!Number.isFinite(value)) return;
			let m = metrics.get(name);
			if (!m) {
				m = {
					kind: "histogram",
					unit: opts.unit,
					bounds: opts.bounds ?? DURATION_BOUNDS,
					series: new Map(),
				};
				metrics.set(name, m);
			}
			if (m.kind !== "histogram") return;
			const key = seriesKey(attrs);
			let point = m.series.get(key);
			if (!point) {
				point = {
					attrs,
					count: 0,
					sum: 0,
					buckets: new Array(m.bounds.length + 1).fill(0),
				};
				m.series.set(key, point);
			}
			point.count++;
			point.sum += value;
			const i = m.bounds.findIndex((b) => value <= b);
			const bucket = i === -1 ? m.bounds.length : i;
			point.buckets[bucket] = (point.buckets[bucket] ?? 0) + 1;
		},
		flush,
		async shutdown() {
			if (timer) clearInterval(timer);
			await flush();
		},
	};
}

/** Build from the standard OTEL_* variables. No OTEL_EXPORTER_OTLP_ENDPOINT = no-op. */
export function telemetryFromEnv(
	env: Record<string, string | undefined>,
	defaults: { serviceName: string; serviceVersion?: string },
): Telemetry {
	return createTelemetry({
		endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
		serviceName: defaults.serviceName,
		serviceVersion: defaults.serviceVersion,
		attrs: { "deployment.environment.name": env.NODE_ENV },
	});
}
