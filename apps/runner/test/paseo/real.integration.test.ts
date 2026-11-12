// The adapter against this machine's REAL Paseo daemon (read-only: no agent
// starts, no host is added). Run with MM_PASEO_REAL=1 where a daemon runs
// (PASEO_HOME, default ~/.paseo; or PASEO_HOST).
import { describe, expect, test } from "bun:test";
import { defaultSettings } from "../../src/config.ts";
import { problems, runChecks } from "../../src/diagnostics.ts";
import { connectPaseo, withPaseo } from "../../src/paseo/client.ts";

const real = process.env.MM_PASEO_REAL === "1";

describe.skipIf(!real)("Paseo SDK adapter on the real daemon", () => {
	test("providers, login, agent lookup and hosts, one connection each", async () => {
		await withPaseo(connectPaseo, undefined, async (p) => {
			const list = await p.providers();
			expect(list.length).toBeGreaterThan(0);
			for (const x of list) {
				expect(typeof x.provider).toBe("string");
				expect(["ready", "loading", "error", "unavailable"]).toContain(
					x.status,
				);
			}
			const ready = list.find((x) => x.status === "ready");
			if (ready) {
				const l = await p.login(ready.provider);
				console.log(
					`real paseo ${p.where}: ${ready.provider} ready, default mode ${ready.defaultMode}, loggedIn ${l.loggedIn} (${l.authMethod}), status ${l.status}`,
				);
				expect(l.status).not.toBeNull();
			}
			expect(
				await p.agentIds({ "mastermind.execution": `none-${Date.now()}` }),
			).toEqual([]);
			expect(Array.isArray(await p.hosts())).toBe(true);
		});
	});

	test("runChecks asks the real daemon; a bad host says why", async () => {
		const s = { ...defaultSettings("it"), queues: ["q"] };
		const c = await runChecks(s, { login: true });
		expect(c.paseo).toBe(true);
		const down = await runChecks(s, { paseoHost: "127.0.0.1:1" });
		expect(down.paseo).toBe(false);
		expect(problems(down, s)[0]?.problem).toContain(
			"the Paseo daemon does not answer",
		);
	});
});
