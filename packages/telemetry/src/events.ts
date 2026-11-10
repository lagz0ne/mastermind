/** What the browser posts to /api/telemetry. Shared by browser.ts and ingest.ts. */

export const VITALS = ["TTFB", "FCP", "LCP", "CLS", "INP"] as const;
export type VitalName = (typeof VITALS)[number];

export type BrowserEvent =
	| { type: "vital"; name: VitalName; value: number; path: string }
	| {
			type: "error";
			message: string;
			stack?: string;
			source?: string;
			path: string;
	  }
	| { type: "route"; path: string; ms: number };

export type BrowserBatch = { events: BrowserEvent[] };

export const MAX_EVENTS = 50;
export const MAX_BODY_BYTES = 64 * 1024;
