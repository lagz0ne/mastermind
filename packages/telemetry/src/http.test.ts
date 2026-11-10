// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect raw OTLP JSON bodies.
import { describe, expect, test } from "bun:test";
import { parseTraceparent, traced } from "./http.ts";
import { browserIngest, pageOf, parseEvent } from "./ingest.ts";
import { createTelemetry, noopTelemetry } from "./telemetry.ts";

function recorder() {
	const bodies: Record<string, any[]> = {};
	const t = createTelemetry({
		endpoint: "http://otlp",
		serviceName: "svc",
		intervalMs: 0,
		fetch: async (url, init) => {
			const path = new URL(url).pathname;
			bodies[path] ??= [];
			bodies[path].push(JSON.parse(String(init.body)));
			return new Response(null, { status: 200 });
		},
	});
	const spans = () =>
		bodies["/v1/traces"]?.flatMap(
			(b) => b.resourceSpans[0].scopeSpans[0].spans,
		) ?? [];
	const logs = () =>
		bodies["/v1/logs"]?.flatMap(
			(b) => b.resourceLogs[0].scopeLogs[0].logRecords,
		) ?? [];
	const metrics = () =>
		bodies["/v1/metrics"]?.at(-1)?.resourceMetrics[0].scopeMetrics[0].metrics ??
		[];
	return { t, spans, logs, metrics };
}

describe("parseTraceparent", () => {
	test("accepts a valid header and rejects junk or zero ids", () => {
		const tid = "4bf92f3577b34da6a3ce929d0e0e4736";
		expect(parseTraceparent(`00-${tid}-00f067aa0ba902b7-01`)).toEqual({
			traceId: tid,
			spanId: "00f067aa0ba902b7",
		});
		expect(parseTraceparent(null)).toBeUndefined();
		expect(parseTraceparent("nope")).toBeUndefined();
		expect(
			parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`),
		).toBeUndefined();
	});
});

describe("traced", () => {
	test("disabled telemetry returns the same routes object", () => {
		const routes = { "/a": () => new Response("a") };
		expect(traced(noopTelemetry, routes)).toBe(routes);
	});

	test("wraps functions and method maps, leaves static values alone", async () => {
		const r = recorder();
		const html = { index: "index.html" };
		const routes = traced(
			r.t,
			{
				"/api/health": (_req: Request) => Response.json({ ok: true }),
				"/api/board": {
					GET: async (_req: Request) => new Response("b", { status: 503 }),
				},
				"/static": new Response("s"),
				"/*": html,
				"/api/skip": () => new Response("k"),
			},
			{ skip: ["/api/skip"] },
		);
		expect(routes["/*"]).toBe(html);
		expect(routes["/static"]).toBeInstanceOf(Response);

		const res = await routes["/api/health"](
			new Request("http://h/api/health", {
				headers: {
					traceparent:
						"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				},
			}),
		);
		expect(res.status).toBe(200);
		await routes["/api/board"].GET(new Request("http://h/api/board"));
		await routes["/api/skip"]();
		await r.t.flush();

		const [health, board] = r.spans();
		expect(r.spans()).toHaveLength(2);
		expect(health).toMatchObject({
			name: "GET /api/health",
			kind: 2,
			status: { code: 1 },
		});
		expect(health.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(health.parentSpanId).toBe("00f067aa0ba902b7");
		expect(board.status).toEqual({ code: 2, message: "HTTP 503" });

		const logs = r.logs();
		expect(logs[0].body.stringValue).toMatch(/^GET \/api\/health 200 \d+ms$/);
		expect(logs[0].traceId).toBe(health.traceId);
		expect(logs[1].severityText).toBe("ERROR");
		const names = r.metrics().map((m: any) => m.name);
		expect(names).toEqual([
			"http.server.requests",
			"http.server.request.duration",
		]);
	});

	test("a throwing handler ends the span with the error and rethrows", async () => {
		const r = recorder();
		const routes = traced(r.t, {
			"/x": (_req: Request) => {
				throw new Error("kaput");
			},
		});
		await expect(routes["/x"](new Request("http://h/x"))).rejects.toThrow(
			"kaput",
		);
		await r.t.flush();
		expect(r.spans()[0].status).toEqual({ code: 2, message: "kaput" });
	});
});

describe("browser ingest", () => {
	const post = (body: unknown, raw?: string) =>
		new Request("http://h/api/telemetry", {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "test-ua" },
			body: raw ?? JSON.stringify(body),
		});

	test("pageOf removes ids from paths", () => {
		expect(pageOf("/board/mm-210.11?x=1")).toBe("/board/:id");
		expect(pageOf("/board")).toBe("/board");
	});

	test("parseEvent rejects bad input", () => {
		expect(
			parseEvent({ type: "vital", name: "XYZ", value: 1 }),
		).toBeUndefined();
		expect(
			parseEvent({ type: "vital", name: "LCP", value: -1 }),
		).toBeUndefined();
		expect(parseEvent({ type: "error", message: "" })).toBeUndefined();
		expect(parseEvent({ type: "route", path: "/a", ms: "5" })).toBeUndefined();
		expect(parseEvent("x")).toBeUndefined();
		expect(parseEvent({ type: "error", message: "m".repeat(5000) })?.type).toBe(
			"error",
		);
	});

	test("valid batch becomes logs and metrics of the web service", async () => {
		const r = recorder();
		const handle = browserIngest(r.t);
		const res = await handle(
			post({
				events: [
					{ type: "vital", name: "LCP", value: 1234.5, path: "/board" },
					{ type: "vital", name: "CLS", value: 0.02, path: "/board" },
					{
						type: "error",
						message: "TypeError: x",
						stack: "at y",
						path: "/board/mm-1",
					},
					{ type: "route", path: "/board/mm-1", ms: 42 },
					{ type: "unknown" },
				],
			}),
		);
		expect(res.status).toBe(204);
		await r.t.flush();
		const msgs = r.logs().map((l: any) => l.body.stringValue);
		expect(msgs).toEqual([
			"vital LCP=1235 /board",
			"vital CLS=0.020 /board",
			"TypeError: x",
			"route /board/mm-1 42ms",
		]);
		expect(r.logs()[2].severityText).toBe("ERROR");
		const names = r
			.metrics()
			.map((m: any) => m.name)
			.sort();
		expect(names).toEqual([
			"web.errors",
			"web.route.duration",
			"web.vitals.cls",
			"web.vitals.lcp",
		]);
		const route = r.metrics().find((m: any) => m.name === "web.route.duration");
		expect(route.histogram.dataPoints[0].attributes).toEqual([
			{ key: "web.page", value: { stringValue: "/board/:id" } },
		]);
	});

	test("bad bodies are rejected", async () => {
		const handle = browserIngest(noopTelemetry);
		expect((await handle(post(null, "{not json"))).status).toBe(400);
		expect((await handle(post({ events: 1 }))).status).toBe(400);
		expect((await handle(post(null, "x".repeat(70_000)))).status).toBe(413);
	});
});
