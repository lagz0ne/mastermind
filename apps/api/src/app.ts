import { type Health, isHealthy } from "@mastermind/core";
import type { SQL } from "bun";

export async function checkDb(sql: SQL | null): Promise<Health["db"]> {
	if (!sql) return "unconfigured";
	try {
		await sql`select 1`;
		return "up";
	} catch {
		return "down";
	}
}

export async function health(
	sql: SQL | null,
	version: string,
): Promise<Response> {
	const db = await checkDb(sql);
	const body: Health = { ok: isHealthy(db), version, db };
	return Response.json(body, { status: body.ok ? 200 : 503 });
}
