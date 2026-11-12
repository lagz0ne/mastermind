/** State of one dependency in `GET /api/health`. */
export type Probe = "up" | "down" | "unconfigured";

/** Shape of `GET /api/health`, shared by the api and the web UI. */
export type Health = {
	ok: boolean;
	version: string;
	/** NATS for the dispatcher; unconfigured while the dispatcher is off. */
	nats: Probe;
	/** The work store on NATS JetStream; unconfigured without NATS. */
	work: Probe;
};

/** Healthy unless something configured is down; unconfigured is fine. */
export function isHealthy(...probes: Probe[]): boolean {
	return probes.every((probe) => probe !== "down");
}

export * from "./dispatch.ts";
export * from "./environment.ts";
export * from "./files.ts";
export * from "./people.ts";
export * from "./runner-version.ts";
export * from "./timeline.ts";
export * from "./work.ts";
