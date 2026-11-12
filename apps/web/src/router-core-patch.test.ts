import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// mm-6q7: router-core's router.js and load-client.js import each other. Bun's dev bundler (HMR,
// `bun run dev`) runs router.js while the load-client binding is still null, so the top-level
// `RouterCore.prototype._replaceRouteChunk = replaceRouteChunk` threw on every page.
// patches/@tanstack%2Frouter-core@<version>.patch defers that read to call time.
// If this test fails after a router upgrade: re-create the patch for the new version
// (bun patch @tanstack/router-core), or drop it if upstream no longer reads load-client.js at
// the top level of router.js. Check with `bun run dev` and open /board.
const reactRouter = Bun.resolveSync("@tanstack/react-router", import.meta.dir);
const routerCore = Bun.resolveSync(
	"@tanstack/router-core",
	dirname(reactRouter),
);
const routerJs = await Bun.file(join(dirname(routerCore), "router.js")).text();

describe("router-core patch (bun dev bundler, circular import)", () => {
	test("router.js does not read a load-client.js import at module top level", () => {
		expect(routerJs).not.toMatch(
			/^\tRouterCore\.prototype\._replaceRouteChunk = replaceRouteChunk;$/m,
		);
	});

	test("the HMR hook still replaces a route chunk", async () => {
		const { RouterCore } = await import(routerCore);
		const route = { lazyFn: undefined as unknown, _lazy: "loaded" };
		const lazyFn = () => Promise.resolve({});
		RouterCore.prototype._replaceRouteChunk.call({}, route, lazyFn);
		expect(route.lazyFn).toBe(lazyFn);
		expect(route._lazy).toBeUndefined();
	});
});
