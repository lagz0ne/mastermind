import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
	BACKUP_NAME,
	ensureBackup,
	hasBeadsSchema,
	parseDoltUrl,
	serverUrl,
} from "./dolt.ts";

test("parseDoltUrl splits a mysql url and decodes credentials", () => {
	expect(
		parseDoltUrl("mysql://root:p%40ss@dolt.internal:3307/mastermind"),
	).toEqual({
		host: "dolt.internal",
		port: 3307,
		user: "root",
		password: "p@ss",
		database: "mastermind",
	});
	expect(parseDoltUrl("mysql://dolt/work")).toMatchObject({
		port: 3306,
		user: "root",
		password: "",
	});
});

test("parseDoltUrl rejects other protocols and a missing database", () => {
	expect(() => parseDoltUrl("postgres://x/db")).toThrow("mysql://");
	expect(() => parseDoltUrl("mysql://x:3306")).toThrow("database");
});

test("serverUrl drops the database", () => {
	expect(serverUrl("mysql://root:pw@dolt:3306/mastermind")).toBe(
		"mysql://root:pw@dolt:3306/",
	);
});

/** A fake tagged-template SQL that records each query and answers from `rows`. */
function fakeSql(rows: (query: string) => unknown[]) {
	const queries: { query: string; values: unknown[] }[] = [];
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		const query = strings.join("?");
		queries.push({ query, values });
		return Promise.resolve(rows(query));
	}) as unknown as SQL;
	return { sql, queries };
}

test("hasBeadsSchema looks for the issues table", async () => {
	const { sql, queries } = fakeSql(() => [{ table_name: "issues" }]);
	expect(await hasBeadsSchema(sql, "mastermind")).toBe(true);
	expect(queries[0]?.values).toEqual(["mastermind"]);
	expect(await hasBeadsSchema(fakeSql(() => []).sql, "x")).toBe(false);
});

test("ensureBackup adds a missing backup", async () => {
	const { sql, queries } = fakeSql(() => []);
	await ensureBackup(sql, "file:///backups/mastermind");
	expect(queries.map((q) => q.values)).toEqual([
		[BACKUP_NAME],
		[BACKUP_NAME, "file:///backups/mastermind"],
	]);
	expect(queries[1]?.query).toContain("dolt_backup('add'");
});

test("ensureBackup leaves a matching backup alone and re-points a stale one", async () => {
	const same = fakeSql(() => [{ name: BACKUP_NAME, url: "file:///b" }]);
	await ensureBackup(same.sql, "file:///b");
	expect(same.queries).toHaveLength(1);

	const stale = fakeSql((q) =>
		q.includes("dolt_backups")
			? [{ name: BACKUP_NAME, url: "file:///old" }]
			: [],
	);
	await ensureBackup(stale.sql, "file:///new");
	expect(
		stale.queries.map((q) => q.query.match(/'(add|remove)'/)?.[1]),
	).toEqual([undefined, "remove", "add"]);
});
