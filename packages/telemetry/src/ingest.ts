/**
 * POST /api/telemetry: the browser cannot reach the OTLP collector, so it posts small
 * batches here and the api re-emits them as logs and metrics of the web service.
 * Input is untrusted: bounded size, bounded strings, unknown events ignored.
 */
import {
	type BrowserEvent,
	MAX_BODY_BYTES,
	MAX_EVENTS,
	VITALS,
	type VitalName,
} from "./events.ts";
import { DURATION_BOUNDS, type Telemetry } from "./telemetry.ts";

const CLS_BOUNDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1];

const str = (v: unknown, max: number): string | undefined =>
	typeof v === "string" && v.length ? v.slice(0, max) : undefined;
const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Low-cardinality page label: path segments that contain a digit become ":id". */
export function pageOf(path: string): string {
	const clean = path.split(/[?#]/)[0] ?? "/";
	return clean
		.split("/")
		.map((s) => (/\d/.test(s) ? ":id" : s))
		.join("/")
		.slice(0, 200);
}

/** Validate one untrusted event; undefined when it is not usable. */
export function parseEvent(raw: unknown): BrowserEvent | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const e = raw as Record<string, unknown>;
	const path = str(e.path, 500) ?? "/";
	switch (e.type) {
		case "vital": {
			const value = num(e.value);
			if (!VITALS.includes(e.name as VitalName) || value === undefined)
				return undefined;
			return { type: "vital", name: e.name as VitalName, value, path };
		}
		case "error": {
			const message = str(e.message, 1000);
			if (!message) return undefined;
			return {
				type: "error",
				message,
				stack: str(e.stack, 4000),
				source: str(e.source, 500),
				path,
			};
		}
		case "route": {
			const ms = num(e.ms);
			return ms === undefined ? undefined : { type: "route", path, ms };
		}
		default:
			return undefined;
	}
}

/** Re-emit one browser event through `t` (the web service's telemetry). */
export function emit(
	t: Telemetry,
	event: BrowserEvent,
	userAgent?: string,
): void {
	const page = pageOf(event.path);
	const common = {
		"url.path": event.path,
		"web.page": page,
		"user_agent.original": userAgent,
	};
	switch (event.type) {
		case "vital": {
			const cls = event.name === "CLS";
			t.record(
				`web.vitals.${event.name.toLowerCase()}`,
				event.value,
				{ "web.page": page },
				{
					unit: cls ? "1" : "ms",
					bounds: cls ? CLS_BOUNDS : DURATION_BOUNDS,
				},
			);
			t.log(
				"info",
				`vital ${event.name}=${cls ? event.value.toFixed(3) : Math.round(event.value)} ${event.path}`,
				{
					...common,
					"web.vital.name": event.name,
					"web.vital.value": event.value,
				},
			);
			return;
		}
		case "error":
			t.count("web.errors", 1, { "web.page": page });
			t.log("error", event.message, {
				...common,
				"exception.message": event.message,
				"exception.stacktrace": event.stack,
				"code.source": event.source,
			});
			return;
		case "route":
			t.record(
				"web.route.duration",
				event.ms,
				{ "web.page": page },
				{ unit: "ms", bounds: DURATION_BOUNDS },
			);
			t.log("info", `route ${event.path} ${Math.round(event.ms)}ms`, {
				...common,
				"web.route.duration_ms": Math.round(event.ms),
			});
			return;
	}
}

/** Handler for POST /api/telemetry. `t` should carry service.name mastermind-web. */
export function browserIngest(
	t: Telemetry,
): (req: Request) => Promise<Response> {
	return async (req) => {
		const declared = Number(req.headers.get("content-length") ?? 0);
		if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
		const text = await req.text();
		if (text.length > MAX_BODY_BYTES)
			return new Response(null, { status: 413 });
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return Response.json({ error: "invalid JSON" }, { status: 400 });
		}
		const events = (body as { events?: unknown })?.events;
		if (!Array.isArray(events))
			return Response.json(
				{ error: "events must be an array" },
				{ status: 400 },
			);
		const ua = req.headers.get("user-agent")?.slice(0, 300) ?? undefined;
		for (const raw of events.slice(0, MAX_EVENTS)) {
			const event = parseEvent(raw);
			if (event) emit(t, event, ua);
		}
		return new Response(null, { status: 204 });
	};
}
