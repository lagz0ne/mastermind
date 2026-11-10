// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect raw OTLP JSON bodies.
import { describe, expect, test } from "bun:test";
import { keyValues, nanos } from "./otlp.ts";
import {
	createTelemetry,
	noopTelemetry,
	telemetryFromEnv,
} from "./telemetry.ts";

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(status = 200) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(null, { status });
	};
	return { calls, fetch };
}

const make = (
	fetch: ReturnType<typeof fakeFetch>["fetch"],
	onError?: (e: unknown) => void,
) => {
	let clock = 1_700_000_000_000;
	return createTelemetry({
		endpoint: "http://otlp:4318/",
		serviceName: "svc",
		serviceVersion: "abc",
		intervalMs: 0,
		fetch,
		now: () => clock++,
		onError,
	});
};

describe("otlp encoding", () => {
	test("nanos keeps precision past 2^53", () => {
		expect(nanos(1_700_000_000_123)).toBe("1700000000123000000");
		expect(nanos(1_700_000_000_123.5)).toBe("1700000000123500000");
	});

	test("keyValues maps types and drops empty values", () => {
		expect(
			keyValues({
				s: "x",
				i: 3,
				d: 1.5,
				b: false,
				u: undefined,
				n: null,
				nan: Number.NaN,
			}),
		).toEqual([
			{ key: "s", value: { stringValue: "x" } },
			{ key: "i", value: { intValue: "3" } },
			{ key: "d", value: { doubleValue: 1.5 } },
			{ key: "b", value: { boolValue: false } },
		]);
	});
});

describe("createTelemetry", () => {
	test("no endpoint is the no-op instance", () => {
		expect(createTelemetry({ serviceName: "x" })).toBe(noopTelemetry);
		expect(telemetryFromEnv({}, { serviceName: "x" }).enabled).toBe(false);
		expect(
			telemetryFromEnv(
				{ OTEL_EXPORTER_OTLP_ENDPOINT: " " },
				{ serviceName: "x" },
			).enabled,
		).toBe(false);
	});

	test("flush posts logs, spans and metrics to the three OTLP paths", async () => {
		const f = fakeFetch();
		const t = make(f.fetch);
		const span = t.startSpan("GET /x", { kind: "server", attrs: { a: 1 } });
		span.set({ b: "two" });
		span.end();
		t.log("info", "hello", { k: "v" }, span);
		t.count("reqs", 1, { route: "/x" });
		t.count("reqs", 2, { route: "/x" });
		t.record("dur", 7, {}, { unit: "ms", bounds: [5, 10] });
		t.record("dur", 50, {});
		await t.flush();

		const byPath = Object.fromEntries(
			f.calls.map((c) => [new URL(c.url).pathname, c.body]),
		);
		expect(Object.keys(byPath).sort()).toEqual([
			"/v1/logs",
			"/v1/metrics",
			"/v1/traces",
		]);

		const logs = byPath["/v1/logs"] as any;
		expect(logs.resourceLogs[0].resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "svc" },
		});
		const rec = logs.resourceLogs[0].scopeLogs[0].logRecords[0];
		expect(rec).toMatchObject({
			severityNumber: 9,
			severityText: "INFO",
			body: { stringValue: "hello" },
		});
		expect(rec.traceId).toBe(span.traceId);
		expect(rec.spanId).toBe(span.spanId);

		const s = (byPath["/v1/traces"] as any).resourceSpans[0].scopeSpans[0]
			.spans[0];
		expect(s).toMatchObject({ name: "GET /x", kind: 2, status: { code: 1 } });
		expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(s.attributes).toContainEqual({
			key: "b",
			value: { stringValue: "two" },
		});

		const metrics = (byPath["/v1/metrics"] as any).resourceMetrics[0]
			.scopeMetrics[0].metrics;
		const reqs = metrics.find((m: any) => m.name === "reqs");
		expect(reqs.sum).toMatchObject({
			isMonotonic: true,
			aggregationTemporality: 2,
		});
		expect(reqs.sum.dataPoints[0].asDouble).toBe(3);
		const dur = metrics.find((m: any) => m.name === "dur");
		expect(dur.unit).toBe("ms");
		expect(dur.histogram.dataPoints[0]).toMatchObject({
			count: "2",
			sum: 57,
			bucketCounts: ["0", "1", "1"],
			explicitBounds: [5, 10],
		});
	});

	test("logs and spans are sent once; metrics stay cumulative", async () => {
		const f = fakeFetch();
		const t = make(f.fetch);
		t.log("warn", "once");
		t.count("c");
		await t.flush();
		t.count("c");
		await t.flush();
		const paths = f.calls.map((c) => new URL(c.url).pathname);
		expect(paths.filter((p) => p === "/v1/logs")).toHaveLength(1);
		const last = f.calls.at(-1)?.body as any;
		expect(
			last.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
				.asDouble,
		).toBe(2);
	});

	test("span() records the error and rethrows", async () => {
		const f = fakeFetch();
		const t = make(f.fetch);
		await expect(
			t.span("dolt.query", () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await t.flush();
		const s = ((f.calls[0] as Call).body as any).resourceSpans[0].scopeSpans[0]
			.spans[0];
		expect(s.status).toEqual({ code: 2, message: "boom" });
	});

	test("child spans inherit the trace id", () => {
		const t = make(fakeFetch().fetch);
		const parent = t.startSpan("p");
		const child = t.startSpan("c", { parent });
		expect(child.traceId).toBe(parent.traceId);
		expect(child.spanId).not.toBe(parent.spanId);
	});

	test("export failure goes to onError and never throws", async () => {
		const f = fakeFetch(503);
		const errors: unknown[] = [];
		const t = make(f.fetch, (e) => errors.push(e));
		t.log("info", "x");
		await t.flush();
		expect(String(errors[0])).toContain("HTTP 503");
	});

	test("queue drops the oldest beyond maxQueue", async () => {
		const f = fakeFetch();
		const t = createTelemetry({
			endpoint: "http://o",
			serviceName: "s",
			intervalMs: 0,
			maxQueue: 2,
			fetch: f.fetch,
		});
		for (const m of ["a", "b", "c"]) t.log("info", m);
		await t.flush();
		const recs = ((f.calls[0] as Call).body as any).resourceLogs[0].scopeLogs[0]
			.logRecords;
		expect(recs.map((r: any) => r.body.stringValue)).toEqual(["b", "c"]);
	});
});
