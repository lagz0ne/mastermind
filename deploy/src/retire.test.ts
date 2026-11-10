import { expect, test } from "bun:test";
import { type EnvServices, findRetired, type ReadOne } from "./retire.ts";

// The shape project.all gives: compose and applications carry a name, postgres does not.
const env: EnvServices = {
	compose: [
		{ composeId: "c1", name: "mastermind-infra", composeStatus: "done" },
	],
	postgres: [{ postgresId: "zN4FfJJdzFULrhZt9dbGu" }],
	applications: [
		{ applicationId: "a1", name: "mastermind", applicationStatus: "done" },
		{ applicationId: "a2", name: "mastermind-nats", applicationStatus: "done" },
	],
};

const postgresOne: ReadOne = async (kind, id) => {
	if (kind === "postgres" && id === "zN4FfJJdzFULrhZt9dbGu")
		return {
			postgresId: id,
			name: "mastermind-db",
			appName: "mastermind-db-x1y2z3",
			applicationStatus: "done",
		};
	throw new Error(`unexpected ${kind}.one ${id}`);
};

test("a postgres entry without a name is read by id, so it is found and not reported gone", async () => {
	const found = await findRetired(
		["mastermind-infra", "mastermind-db"],
		env,
		postgresOne,
	);
	expect(found).toEqual([
		{ name: "mastermind-infra", kind: "compose", id: "c1", status: "done" },
		{
			name: "mastermind-db",
			kind: "postgres",
			id: "zN4FfJJdzFULrhZt9dbGu",
			status: "done",
		},
	]);
});

test("a service matches by appName too", async () => {
	const found = await findRetired(["mastermind-db-x1y2z3"], env, postgresOne);
	expect(found.map((r) => [r.kind, r.id])).toEqual([
		["postgres", "zN4FfJJdzFULrhZt9dbGu"],
	]);
});

test("services in use are never matched, and nothing retired means no reads", async () => {
	const reads: string[] = [];
	const found = await findRetired([], env, async (kind, id) => {
		reads.push(`${kind} ${id}`);
		return {};
	});
	expect(found).toEqual([]);
	expect(reads).toEqual([]);
	expect(
		(await findRetired(["mastermind-db"], env, postgresOne)).map((r) => r.name),
	).toEqual(["mastermind-db"]);
});

test("a failed read is an error, not a missing service", async () => {
	await expect(
		findRetired(["mastermind-db"], env, async () => {
			throw new Error("dokploy postgres.one: 500");
		}),
	).rejects.toThrow("postgres.one: 500");
});
