import { describe, expect, test } from "bun:test";
import type { Environment } from "@mastermind/core";
import { runnerApiRoutes } from "./routes.ts";

const env = (over: Partial<Environment>): Environment =>
	({
		name: "web",
		description: "",
		repo: "https://github.com/x/web.git",
		ref: "main",
		requires: [],
		setup: ["bun install"],
		check: [],
		secrets: [],
		...over,
	}) as Environment;

const doc = {
	environments: [
		env({
			name: "web",
			secrets: ["GITHUB_TOKEN"],
			provider: { name: "claude", auth: "CLAUDE_CODE_OAUTH_TOKEN" },
		}),
		env({ name: "docs" }),
	],
};

const routes = (over: { auth?: boolean; store?: boolean } = {}) =>
	runnerApiRoutes({
		auth: () =>
			over.auth === false
				? null
				: {
						authorize: async (c: string) =>
							c === "mms_alice_1_ok"
								? ({ id: "1", name: "laptop", account: "alice" } as never)
								: null,
					},
		environments: () =>
			over.store === false
				? null
				: { read: async () => ({ doc, revision: 3 }) as never },
	})["/api/runner/environments"].GET;

const get = (auth?: string) =>
	new Request("http://mm/api/runner/environments", {
		headers: auth ? { authorization: auth } : {},
	});

describe("GET /api/runner/environments", () => {
	test("a valid credential gets names and secret names only", async () => {
		const res = await routes()(get("Bearer mms_alice_1_ok"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			environments: [
				{ name: "web", secrets: ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] },
				{ name: "docs", secrets: [] },
			],
		});
		expect(JSON.stringify(body)).not.toContain("bun install");
	});
	test("no or a bad credential: 401", async () => {
		expect((await routes()(get())).status).toBe(401);
		expect((await routes()(get("Bearer nope"))).status).toBe(401);
	});
	test("auth or store not ready: 503", async () => {
		expect((await routes({ auth: false })(get("Bearer x"))).status).toBe(503);
		expect((await routes({ store: false })(get("Bearer x"))).status).toBe(503);
	});
});
