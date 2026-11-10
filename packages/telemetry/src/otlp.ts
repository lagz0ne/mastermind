/**
 * OTLP/HTTP JSON encoding (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).
 * Pure functions: no I/O, no clock. Times are unix epoch milliseconds (fractions allowed).
 */

export type AttrValue = string | number | boolean;
/** Attribute bag. `undefined` and `null` values are dropped. */
export type Attrs = Record<string, AttrValue | undefined | null>;

export type KeyValue = {
	key: string;
	value:
		| { stringValue: string }
		| { intValue: string }
		| { doubleValue: number }
		| { boolValue: boolean };
};

export const SCOPE = { name: "@mastermind/telemetry" };

export function keyValues(attrs: Attrs | undefined): KeyValue[] {
	const out: KeyValue[] = [];
	for (const [key, v] of Object.entries(attrs ?? {})) {
		if (v === undefined || v === null) continue;
		if (typeof v === "string") out.push({ key, value: { stringValue: v } });
		else if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
		else if (Number.isSafeInteger(v))
			out.push({ key, value: { intValue: String(v) } });
		else if (Number.isFinite(v)) out.push({ key, value: { doubleValue: v } });
	}
	return out;
}

/** Epoch milliseconds to the OTLP fixed64 nanosecond string, without float overflow. */
export function nanos(ms: number): string {
	const whole = Math.floor(ms);
	const frac = Math.round((ms - whole) * 1e6);
	return (BigInt(whole) * 1_000_000n + BigInt(frac)).toString();
}

export type Resource = { attributes: KeyValue[] };

export function resource(attrs: Attrs): Resource {
	return { attributes: keyValues(attrs) };
}

// ---- logs -------------------------------------------------------------------

export type Severity = "debug" | "info" | "warn" | "error";

const SEVERITY_NUMBER: Record<Severity, number> = {
	debug: 5,
	info: 9,
	warn: 13,
	error: 17,
};

export type LogRecord = {
	time: number;
	severity: Severity;
	message: string;
	attrs?: Attrs;
	traceId?: string;
	spanId?: string;
};

export function logsBody(res: Resource, records: LogRecord[]) {
	return {
		resourceLogs: [
			{
				resource: res,
				scopeLogs: [
					{
						scope: SCOPE,
						logRecords: records.map((r) => ({
							timeUnixNano: nanos(r.time),
							observedTimeUnixNano: nanos(r.time),
							severityNumber: SEVERITY_NUMBER[r.severity],
							severityText: r.severity.toUpperCase(),
							body: { stringValue: r.message },
							attributes: keyValues(r.attrs),
							...(r.traceId ? { traceId: r.traceId, spanId: r.spanId } : {}),
						})),
					},
				],
			},
		],
	};
}

// ---- traces -----------------------------------------------------------------

export type SpanKind = "internal" | "server" | "client";
const SPAN_KIND: Record<SpanKind, number> = {
	internal: 1,
	server: 2,
	client: 3,
};

export type SpanRecord = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: SpanKind;
	start: number;
	end: number;
	attrs?: Attrs;
	/** Set when the operation failed. */
	error?: string;
};

export function tracesBody(res: Resource, spans: SpanRecord[]) {
	return {
		resourceSpans: [
			{
				resource: res,
				scopeSpans: [
					{
						scope: SCOPE,
						spans: spans.map((s) => ({
							traceId: s.traceId,
							spanId: s.spanId,
							...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
							name: s.name,
							kind: SPAN_KIND[s.kind],
							startTimeUnixNano: nanos(s.start),
							endTimeUnixNano: nanos(s.end),
							attributes: keyValues(s.attrs),
							status:
								s.error === undefined
									? { code: 1 }
									: { code: 2, message: s.error },
						})),
					},
				],
			},
		],
	};
}

// ---- metrics ----------------------------------------------------------------

/** OTLP AGGREGATION_TEMPORALITY_CUMULATIVE: values are totals since `start`. */
const CUMULATIVE = 2;

export type CounterPoint = { attrs: Attrs; value: number };
export type HistogramPoint = {
	attrs: Attrs;
	count: number;
	sum: number;
	buckets: number[];
};

export type MetricRecord =
	| { kind: "counter"; name: string; unit?: string; points: CounterPoint[] }
	| {
			kind: "histogram";
			name: string;
			unit?: string;
			bounds: number[];
			points: HistogramPoint[];
	  };

export function metricsBody(
	res: Resource,
	metrics: MetricRecord[],
	start: number,
	now: number,
) {
	const startTimeUnixNano = nanos(start);
	const timeUnixNano = nanos(now);
	return {
		resourceMetrics: [
			{
				resource: res,
				scopeMetrics: [
					{
						scope: SCOPE,
						metrics: metrics.map((m) =>
							m.kind === "counter"
								? {
										name: m.name,
										...(m.unit ? { unit: m.unit } : {}),
										sum: {
											aggregationTemporality: CUMULATIVE,
											isMonotonic: true,
											dataPoints: m.points.map((p) => ({
												attributes: keyValues(p.attrs),
												startTimeUnixNano,
												timeUnixNano,
												asDouble: p.value,
											})),
										},
									}
								: {
										name: m.name,
										...(m.unit ? { unit: m.unit } : {}),
										histogram: {
											aggregationTemporality: CUMULATIVE,
											dataPoints: m.points.map((p) => ({
												attributes: keyValues(p.attrs),
												startTimeUnixNano,
												timeUnixNano,
												count: String(p.count),
												sum: p.sum,
												bucketCounts: p.buckets.map(String),
												explicitBounds: m.bounds,
											})),
										},
									},
						),
					},
				],
			},
		],
	};
}
