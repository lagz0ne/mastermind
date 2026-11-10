import { type Health, isHealthy, type Probe } from "@mastermind/core";
import type { SQL } from "bun";
import { checkBd } from "./bd-serve.ts";
import { checkSql } from "./dolt.ts";

export type Deps = {
	/** Postgres: Mastermind's own state. */
	db: SQL | null;
	/** Dolt: the work, read directly. */
	dolt: SQL | null;
	/** Base URL of the supervised `bd serve`. */
	bdUrl: string | null;
	/** Probe of the dispatcher's NATS connection; null while the dispatcher is off. */
	nats: (() => Promise<Probe>) | null;
	/** Probe of the NATS work store (WORK_STORE=nats); absent with beads. */
	work?: (() => Promise<Probe>) | null;
};

export const noDeps: Deps = { db: null, dolt: null, bdUrl: null, nats: null };

async function probeNats(probe: Deps["nats"]): Promise<Probe> {
	if (!probe) return "unconfigured";
	return probe().catch(() => "down");
}

export async function health(deps: Deps, version: string): Promise<Response> {
	const [db, dolt, bd, nats, work] = await Promise.all([
		checkSql(deps.db),
		checkSql(deps.dolt),
		checkBd(deps.bdUrl),
		probeNats(deps.nats),
		deps.work ? probeNats(deps.work) : undefined,
	]);
	// `work` (the NATS work store) shows only when WORK_STORE=nats.
	const body: Health & { work?: Probe } = {
		ok: isHealthy(db, dolt, bd, nats, ...(work ? [work] : [])),
		version,
		db,
		dolt,
		bd,
		nats,
		...(work ? { work } : {}),
	};
	return Response.json(body, { status: body.ok ? 200 : 503 });
}
