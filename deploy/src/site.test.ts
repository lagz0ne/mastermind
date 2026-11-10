import { expect, test } from "bun:test";
import { parseSite } from "./site.ts";

const site = {
	dokployUrl: "https://dokploy.example.com/",
	publicUrl: "https://mm.example.com/",
	project: "p",
	app: "a",
	infra: "i",
	nats: "n",
	repo: "https://example.com/r.git",
	branch: "main",
	githubEnvironment: "production",
};

test("a site for another host and another Dokploy parses, with slashes trimmed", () => {
	const parsed = parseSite(JSON.stringify(site), "site.json");
	expect(parsed.dokployUrl).toBe("https://dokploy.example.com");
	expect(parsed.publicUrl).toBe("https://mm.example.com");
	expect(parsed.appEnv).toEqual({});
});

test("a missing key is named in the error", () => {
	const { publicUrl: _, ...rest } = site;
	expect(() => parseSite(JSON.stringify(rest), "site.json")).toThrow(
		'site.json: "publicUrl" is missing',
	);
});

test("appEnv values must be strings", () => {
	expect(() =>
		parseSite(JSON.stringify({ ...site, appEnv: { PORT: 1 } }), "site.json"),
	).toThrow("appEnv.PORT must be a string");
});
