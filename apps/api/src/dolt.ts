// Dolt sql-server: where the work (beads) lives. Mastermind reads it with
// Bun.SQL over the MySQL protocol and writes through `bd serve` (bd-serve.ts).
import type { Probe } from "@mastermind/core";
import type { SQL } from "bun";

export type DoltTarget = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
};

/** `mysql://user:password@host:port/database` → its parts. */
export function parseDoltUrl(raw: string): DoltTarget {
	const url = new URL(raw);
	if (url.protocol !== "mysql:") {
		throw new Error(`DOLT_URL must be mysql://..., got ${url.protocol}`);
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
	if (!database) throw new Error("DOLT_URL needs a database: mysql://.../db");
	return {
		host: url.hostname,
		port: Number(url.port || 3306),
		user: decodeURIComponent(url.username || "root"),
		password: decodeURIComponent(url.password),
		database,
	};
}

/** The same server without a database, for checks that run before it exists. */
export function serverUrl(raw: string): string {
	const url = new URL(raw);
	url.pathname = "/";
	return url.toString();
}

export async function checkSql(sql: SQL | null): Promise<Probe> {
	if (!sql) return "unconfigured";
	try {
		await sql`select 1`;
		return "up";
	} catch {
		return "down";
	}
}

/**
 * Whether bd has created its schema in `database`. Asks for the issues table,
 * not the database, so a first boot that died halfway is bootstrapped again.
 * `server` is a connection without a database selected.
 */
export async function hasBeadsSchema(
	server: SQL,
	database: string,
): Promise<boolean> {
	const rows =
		await server`select table_name from information_schema.tables where table_schema = ${database} and table_name = 'issues'`;
	return rows.length > 0;
}

export const BACKUP_NAME = "mastermind-backup";

/** Register (or re-point) the Dolt backup of the connected database. */
export async function ensureBackup(sql: SQL, url: string): Promise<void> {
	const rows: { name: string; url: string }[] =
		await sql`select name, url from dolt_backups where name = ${BACKUP_NAME}`;
	if (rows[0]?.url === url) return;
	if (rows[0]) await sql`call dolt_backup('remove', ${BACKUP_NAME})`;
	await sql`call dolt_backup('add', ${BACKUP_NAME}, ${url})`;
}

/** Push the whole database (history included) to the backup. */
export async function syncBackup(sql: SQL): Promise<void> {
	await sql`call dolt_backup('sync', ${BACKUP_NAME})`;
}
