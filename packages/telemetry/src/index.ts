/**
 * @mastermind/telemetry: OTLP/HTTP (JSON) logs, traces and metrics on fetch.
 * Server entry. The browser collector is at "@mastermind/telemetry/browser".
 *
 * Env: OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://otlp-ingest:4318). Unset = no-op.
 */
export type { BrowserBatch, BrowserEvent, VitalName } from "./events.ts";
export { parseTraceparent, traced, traceHandler } from "./http.ts";
export { browserIngest, emit, pageOf, parseEvent } from "./ingest.ts";
export {
	type Attrs,
	createTelemetry,
	DURATION_BOUNDS,
	type HistogramOptions,
	noopTelemetry,
	type Severity,
	type Span,
	type SpanContext,
	type SpanOptions,
	type Telemetry,
	type TelemetryOptions,
	telemetryFromEnv,
} from "./telemetry.ts";
