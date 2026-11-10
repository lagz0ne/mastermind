import { type Health, isHealthy } from "@mastermind/core";
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
};

export const noDeps: Deps = { db: null, dolt: null, bdUrl: null };

export async function health(deps: Deps, version: string): Promise<Response> {
	const [db, dolt, bd] = await Promise.all([
		checkSql(deps.db),
		checkSql(deps.dolt),
		checkBd(deps.bdUrl),
	]);
	const body: Health = { ok: isHealthy(db, dolt, bd), version, db, dolt, bd };
	return Response.json(body, { status: body.ok ? 200 : 503 });
}
