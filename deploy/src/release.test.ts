import { expect, test } from "bun:test";
import { describeQueue, findOurs, pinImage, releaseTitle } from "./release.ts";

const sha = "35a0e1d0123456789abcdef0123456789abcdef0";

test("pinImage replaces the tag with the commit tag that CI publishes", () => {
	expect(pinImage("ghcr.io/o/mm:latest", sha)).toBe(`ghcr.io/o/mm:sha-${sha}`);
	expect(pinImage(`ghcr.io/o/mm:sha-${"1".repeat(40)}`, sha)).toBe(
		`ghcr.io/o/mm:sha-${sha}`,
	);
	expect(pinImage("ghcr.io/o/mm", sha)).toBe(`ghcr.io/o/mm:sha-${sha}`);
	expect(pinImage(`ghcr.io/o/mm@sha256:${"a".repeat(64)}`, sha)).toBe(
		`ghcr.io/o/mm:sha-${sha}`,
	);
	// a registry port is not a tag
	expect(pinImage("reg:5000/mm:latest", "latest")).toBe("reg:5000/mm:latest");
	expect(pinImage("reg:5000/mm", "latest")).toBe("reg:5000/mm:latest");
});

test("pinImage refuses a short or odd ref", () => {
	expect(() => pinImage("ghcr.io/o/mm:latest", "35a0e1d")).toThrow(/40-hex/);
	expect(() => pinImage("ghcr.io/o/mm:latest", "main")).toThrow(/40-hex/);
	expect(() => pinImage("", sha)).toThrow(/no docker image/);
});

test("findOurs takes the newest record with our title made after we asked", () => {
	const asked = Date.parse("2026-11-10T08:00:00Z");
	const title = releaseTitle(sha);
	expect(title).toBe("release 35a0e1d");
	const ours = findOurs(
		[
			{
				deploymentId: "old",
				title,
				status: "done",
				createdAt: "2026-11-10T07:00:00Z",
			},
			{
				deploymentId: "hook",
				title: "NEW CHANGES",
				status: "done",
				createdAt: "2026-11-10T08:01:00Z",
			},
			{
				deploymentId: "a",
				title,
				status: "error",
				createdAt: "2026-11-10T08:02:00Z",
			},
			{
				deploymentId: "b",
				title,
				status: "running",
				createdAt: "2026-11-10T08:03:00Z",
			},
		],
		title,
		asked,
	);
	expect(ours?.deploymentId).toBe("b");
	expect(findOurs([], title, asked)).toBeUndefined();
});

test("describeQueue says what runs and how many jobs are ahead of ours", () => {
	const job = (
		id: string,
		state: string,
		timestamp: number,
		applicationId: string,
	) => ({
		id,
		state,
		timestamp,
		data: { applicationId, titleLog: `build ${id}\nbody` },
	});
	const jobs = [
		job("j3", "waiting", 3, "ours"),
		job("j1", "active", 1, "other"),
		job("j2", "waiting", 2, "other"),
	];
	expect(describeQueue(jobs, "ours")).toBe(
		"dokploy queue: 1 running (build j1), 2 waiting, ours waits behind 1 job",
	);
	expect(describeQueue([], "ours")).toBe(
		"dokploy queue: 0 running, 0 waiting, ours is not waiting",
	);
});
