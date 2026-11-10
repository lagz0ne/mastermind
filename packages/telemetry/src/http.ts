/**
 * Server instrumentation for a Bun.serve `routes` object: one server span, one log line
 * and two metrics per request. Static values (HTML bundles, Response objects) are left
 * as they are, because Bun serves them without calling our code.
 */
import {
	DURATION_BOUNDS,
	type SpanContext,
	type Telemetry,
} from "./telemetry.ts";

const METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);

// biome-ignore lint/suspicious/noExplicitAny: Bun passes (req, server); we forward both untouched.
type AnyHandler = (req: Request, ...rest: any[]) => unknown;

/** W3C traceparent: 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>. */
export function parseTraceparent(
	header: string | null,
): SpanContext | undefined {
	const m = header
		?.trim()
		.match(/^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
	if (!m?.[1] || !m[2] || /^0+$/.test(m[1]) || /^0+$/.test(m[2]))
		return undefined;
	return { traceId: m[1], spanId: m[2] };
}

export function traceHandler<H extends AnyHandler>(
	t: Telemetry,
	route: string,
	handler: H,
): H {
	const wrapped = async (req: Request, ...rest: unknown[]) => {
		const started = performance.now();
		const span = t.startSpan(`${req.method} ${route}`, {
			kind: "server",
			parent: parseTraceparent(req.headers.get("traceparent")),
			attrs: {
				"http.request.method": req.method,
				"http.route": route,
				"url.path": new URL(req.url).pathname,
				"user_agent.original": req.headers.get("user-agent"),
			},
		});
		let status = 500;
		let failure: unknown;
		try {
			const res = await handler(req, ...rest);
			if (res instanceof Response) status = res.status;
			return res;
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			const ms = performance.now() - started;
			span.set({ "http.response.status_code": status });
			span.end(failure ?? (status >= 500 ? `HTTP ${status}` : undefined));
			const attrs = {
				"http.request.method": req.method,
				"http.route": route,
				"http.response.status_code": status,
			};
			t.count("http.server.requests", 1, attrs);
			t.record("http.server.request.duration", ms, attrs, {
				unit: "ms",
				bounds: DURATION_BOUNDS,
			});
			t.log(
				status >= 500 ? "error" : "info",
				`${req.method} ${new URL(req.url).pathname} ${status} ${Math.round(ms)}ms`,
				{ ...attrs, "http.server.request.duration_ms": Math.round(ms) },
				span,
			);
		}
	};
	return wrapped as unknown as H;
}

/**
 * Wrap every handler in a Bun `routes` object. Returns the routes unchanged when
 * telemetry is disabled. `skip` lists route patterns to leave alone.
 */
export function traced<R extends Record<string, unknown>>(
	t: Telemetry,
	routes: R,
	options: { skip?: string[] } = {},
): R {
	if (!t.enabled) return routes;
	const skip = new Set(options.skip);
	const out: Record<string, unknown> = {};
	for (const [route, value] of Object.entries(routes)) {
		if (skip.has(route)) out[route] = value;
		else if (typeof value === "function")
			out[route] = traceHandler(t, route, value as AnyHandler);
		else if (isMethodMap(value)) {
			const methods: Record<string, unknown> = {};
			for (const [method, h] of Object.entries(value))
				methods[method] =
					typeof h === "function" ? traceHandler(t, route, h as AnyHandler) : h;
			out[route] = methods;
		} else out[route] = value;
	}
	return out as R;
}

function isMethodMap(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || value instanceof Response)
		return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((k) => METHODS.has(k));
}
