/** State of one dependency in `GET /api/health`. */
export type Probe = "up" | "down" | "unconfigured";

/** Shape of `GET /api/health`, shared by the api and the web UI. */
export type Health = {
	ok: boolean;
	version: string;
	/** Postgres: Mastermind's own state. */
	db: Probe;
	/** Dolt sql-server: the work (beads), read with Bun.SQL. */
	dolt: Probe;
	/** `bd serve` on loopback: the write path for beads. */
	bd: Probe;
	/** NATS for the dispatcher; unconfigured while the dispatcher is off. */
	nats: Probe;
};

/** Healthy unless something configured is down; unconfigured is fine. */
export function isHealthy(...probes: Probe[]): boolean {
	return probes.every((probe) => probe !== "down");
}

export * from "./dispatch.ts";
export * from "./work.ts";
