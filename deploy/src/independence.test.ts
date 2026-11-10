// Mastermind is the code: it may use services, but only through configuration.
// This guard fails when code names this machine, the hub tools, or one site's host.
import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
// Built from parts so that this file does not match itself.
const machine = [
	["~", "work"].join("/"),
	["hub", "q"].join(""),
	["", "home", "rocky"].join("/"),
	[".config", "secrets"].join("/"),
];
const siteHost = ["vibea", "dev"].join(".");

const skip = /(^|\/)(node_modules|dist|\.turbo)\//;
/** Docs may show example values. The site file is where site values belong. */
const mayNameTheSite = (path: string) =>
	path.endsWith(".md") || path === "deploy/site.json";

async function offenders(
	dirs: string[],
	needles: string[],
	allow: (path: string) => boolean,
) {
	const found: string[] = [];
	for (const dir of dirs) {
		for await (const rel of new Bun.Glob("**/*").scan({
			cwd: join(root, dir),
			onlyFiles: true,
		})) {
			const path = `${dir}/${rel}`;
			if (skip.test(path) || allow(path)) continue;
			const text = await Bun.file(join(root, path))
				.text()
				.catch(() => "");
			for (const needle of needles)
				if (text.includes(needle)) found.push(`${path}: ${needle}`);
		}
	}
	return found;
}

test("no code depends on this machine or on the hub tools", async () => {
	expect(
		await offenders(["apps", "packages", "deploy"], machine, (p) =>
			p.endsWith(".md"),
		),
	).toEqual([]);
});

test("no code names the site host: it comes from configuration", async () => {
	expect(
		await offenders(["apps", "packages", "deploy"], [siteHost], mayNameTheSite),
	).toEqual([]);
});
