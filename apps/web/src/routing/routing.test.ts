import { describe, expect, test } from "bun:test";
import {
	ApiError,
	addMember,
	addQueue,
	addRule,
	changes,
	describeMatch,
	docOf,
	moveRule,
	parseLabels,
	parseTry,
	type RoutingDoc,
	removeMember,
	removeQueue,
	saveRouting,
	setDefaultQueue,
	suggestDefault,
} from "./routing.ts";

const DOC: RoutingDoc = {
	queues: [
		{ name: "backend", description: "", members: ["alice"] },
		{ name: "web", description: "", members: [] },
	],
	rules: [
		{ match: { labels: ["area:api"] }, queue: "backend" },
		{ match: { type: "bug", maxPriority: 1 }, queue: "web" },
	],
};

describe("edits", () => {
	test("moveRule swaps neighbours and ignores the edges", () => {
		expect(moveRule(DOC, 1, -1).rules.map((r) => r.queue)).toEqual([
			"web",
			"backend",
		]);
		expect(moveRule(DOC, 0, -1)).toBe(DOC);
		expect(moveRule(DOC, 1, 1)).toBe(DOC);
	});

	test("members stay unique; removing a queue drops its rules", () => {
		const d = addMember(addMember(DOC, "web", "bob"), "web", "bob");
		expect(d.queues[1]?.members).toEqual(["bob"]);
		expect(removeMember(d, "web", "bob").queues[1]?.members).toEqual([]);
		const r = removeQueue(DOC, "backend");
		expect(r.queues.map((q) => q.name)).toEqual(["web"]);
		expect(r.rules.map((x) => x.queue)).toEqual(["web"]);
	});

	test("addQueue ignores a duplicate; addRule targets the first queue", () => {
		expect(addQueue(DOC, "web")).toBe(DOC);
		expect(addRule(DOC).rules.at(-1)).toEqual({ match: {}, queue: "backend" });
	});

	test("changes counts queue and rule differences", () => {
		expect(changes(DOC, DOC)).toBe(0);
		expect(changes(DOC, moveRule(DOC, 1, -1))).toBe(2);
		expect(changes(DOC, addQueue(DOC, "infra"))).toBe(1);
	});
});

describe("text", () => {
	test("labels split on spaces and commas", () => {
		expect(parseLabels(" area:api, ui  ui ")).toEqual(["area:api", "ui"]);
	});
	test("describeMatch reads like the api", () => {
		expect(describeMatch({})).toBe("every bead");
		expect(describeMatch({ type: "bug", maxPriority: 1 })).toBe(
			"type bug and priority P1 or more urgent",
		);
	});
	test("parseTry: an id, or a sketch", () => {
		expect(parseTry("mm-210.25")).toEqual({ beadId: "mm-210.25" });
		expect(parseTry("bug P0 area:api ui")).toEqual({
			bead: { type: "bug", priority: 0, labels: ["area:api", "ui"] },
		});
		expect(parseTry("area:api")).toEqual({
			bead: { priority: 2, labels: ["area:api"] },
		});
		expect(parseTry("  ")).toBeNull();
	});
});

describe("api", () => {
	test("save sends the revision with the CSRF header; 409 carries current", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetcher = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url === "/api/auth/me") return Response.json({ csrf: "tok" });
			return Response.json(
				{
					error: "somebody else saved routing first",
					current: { ...DOC, revision: 9 },
				},
				{ status: 409 },
			);
		}) as typeof fetch;
		const err = await saveRouting(DOC, 3, fetcher).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(409);
		expect(
			((err as ApiError).body.current as { revision: number }).revision,
		).toBe(9);
		const put = calls.find((c) => c.url === "/api/routing");
		expect(put?.init?.method).toBe("PUT");
		const headers = (put?.init?.headers ?? {}) as Record<string, string>;
		expect(headers["x-csrf-token"]).toBe("tok");
		expect(JSON.parse(String(put?.init?.body)).revision).toBe(3);
	});
});

describe("default queue", () => {
	const one: RoutingDoc = {
		queues: [{ name: "build", description: "", members: ["lagz0ne"] }],
		rules: [],
	};
	test("one queue and no rules: suggest it; not once a default or a rule exists", () => {
		expect(suggestDefault(one)).toBe("build");
		expect(suggestDefault(setDefaultQueue(one, "build"))).toBeNull();
		expect(suggestDefault(addRule(one))).toBeNull();
		expect(suggestDefault(DOC)).toBeNull();
		expect(suggestDefault({ queues: [], rules: [] })).toBeNull();
	});
	test("set, clear, count as a change, and keep through docOf", () => {
		const d = setDefaultQueue(one, "build");
		expect(d.defaultQueue).toBe("build");
		expect(changes(one, d)).toBe(1);
		expect(docOf({ ...d, revision: 3 } as RoutingDoc)).toEqual(d);
		expect(setDefaultQueue(d, null)).toEqual(one);
		expect(setDefaultQueue(one, "nope")).toEqual(one);
	});
	test("removing the default queue clears it", () => {
		const d = setDefaultQueue(DOC, "web");
		expect(removeQueue(d, "web").defaultQueue).toBeUndefined();
		expect(removeQueue(d, "backend").defaultQueue).toBe("web");
	});
});
