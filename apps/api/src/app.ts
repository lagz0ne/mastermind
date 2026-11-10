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
};

export const noDeps: Deps = { db: null, dolt: null, bdUrl: null, nats: null };

async function probeNats(probe: Deps["nats"]): Promise<Probe> {
	if (!probe) return "unconfigured";
	return probe().catch(() => "down");
}

export async function health(deps: Deps, version: string): Promise<Response> {
	const [db, dolt, bd, nats] = await Promise.all([
		checkSql(deps.db),
		checkSql(deps.dolt),
		checkBd(deps.bdUrl),
		probeNats(deps.nats),
	]);
	const body: Health = {
		ok: isHealthy(db, dolt, bd, nats),
		version,
		db,
		dolt,
		bd,
		nats,
	};
	return Response.json(body, { status: body.ok ? 200 : 503 });
}
