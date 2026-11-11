import { expect, test } from "bun:test";
import { type GitHub, type Job, natsBase, type Run } from "./nats-base.ts";

const run = (id: number, sha: string, at: string, branch = "main"): Run => ({
	id,
	head_sha: sha,
	created_at: `2026-11-10T${at}:00Z`,
	head_branch: branch,
});
const deploy = (conclusion: string | null): Job[] => [
	{
		name: "check",
		steps: [{ name: "Run bun run check", conclusion: "success" }],
	},
	{
		name: "deploy",
		steps: [
			{ name: "Redeploy what changed since the live commit", conclusion },
			{
				name: "Wait until production serves this commit",
				conclusion: "failure",
			},
		],
	},
];
const fake = (runs: Run[], jobs: Record<number, Job[]>): GitHub => ({
	runs: async () => runs,
	jobs: async (id) => jobs[id] ?? [],
});

test("the incident: a run after a failed deploy wait does not count the old NATS change again", async () => {
	// 1f76e00 posted the NATS hook, then its wait step failed (prod lagged).
	// The next run (8e2b1ed) compares with 1f76e00, not with the lagging live app.
	const runs = [
		run(3, "8e2b1ed", "12:30"),
		run(2, "1f76e00", "12:22"),
		run(1, "f45bcf9", "12:03"),
	];
	const gh = fake(runs, { 2: deploy("success"), 1: deploy("success") });
	expect(await natsBase(gh, { id: 3, branch: "main" })).toBe("1f76e00");
});

test("runs whose redeploy step did not succeed (cancelled, red check) are skipped", async () => {
	const runs = [
		run(5, "e", "12:50"),
		run(4, "d", "12:40"),
		run(3, "c", "12:30"),
		run(2, "b", "12:20"),
		run(1, "a", "12:10"),
	];
	const gh = fake(runs, {
		4: [], // cancelled before any job
		3: [{ name: "check", steps: [] }], // red check: no deploy job
		2: deploy("failure"),
		1: deploy("success"),
	});
	expect(await natsBase(gh, { id: 5, branch: "main" })).toBe("a");
});

test("only earlier runs of the same branch count", async () => {
	const runs = [
		run(4, "later", "13:00"),
		run(3, "me", "12:30"),
		run(2, "other", "12:20", "feature"),
		run(1, "a", "12:10"),
	];
	const all = {
		4: deploy("success"),
		2: deploy("success"),
		1: deploy("success"),
	};
	expect(await natsBase(fake(runs, all), { id: 3, branch: "main" })).toBe("a");
});

test("no earlier successful redeploy: null (CI then leaves NATS alone)", async () => {
	const runs = [run(2, "me", "12:30"), run(1, "a", "12:10")];
	expect(
		await natsBase(fake(runs, { 1: deploy("failure") }), {
			id: 2,
			branch: "main",
		}),
	).toBeNull();
	expect(await natsBase(fake([], {}), { id: 9, branch: "main" })).toBeNull();
});
