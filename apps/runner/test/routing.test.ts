import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Dispatch } from "@mastermind/core";
import { ConfigError } from "../src/config.ts";
import {
	decisionLine,
	implicitRouting,
	lintRouting,
	parseRouting,
	type Routing,
	route,
} from "../src/routing.ts";
import { dispatch } from "./fakes.ts";

const dir = tmpdir();

/** The sample of the README: two targets, three rules. */
const SAMPLE = {
	targets: {
		laptop: { provider: "claude", mode: "bypassPermissions" },
		gpu: {
			paseoHost: "gpu-box:6767",
			provider: "codex",
			labels: { pool: "gpu" },
			capacity: 1,
		},
	},
	environments: { web: { dir, allowSetup: true }, ml: { dir } },
	rules: [
		{ match: { labels: ["secret-project"] }, decline: "not on this machine" },
		{ match: { env: "ml" }, target: "gpu" },
		{ match: { queue: "q", maxPriority: 2 }, target: "laptop", mode: "auto" },
	],
};

const sample = (): Routing => parseRouting(structuredClone(SAMPLE));

function d(
	over: {
		env?: string;
		queue?: string;
		priority?: number;
		labels?: string[];
		provider?: string;
		mode?: string;
	} = {},
): Dispatch {
	const base = dispatch("mm-9");
	return {
		...base,
		queue: over.queue ?? "q",
		bead: {
			...base.bead,
			priority: (over.priority ?? 2) as Dispatch["bead"]["priority"],
			labels: [...base.bead.labels, ...(over.labels ?? [])],
		},
		env: {
			...base.env,
			...(over.env ? { name: over.env } : {}),
			...(over.provider || over.mode
				? { agent: { provider: over.provider, mode: over.mode } }
				: {}),
		},
	};
}

describe("route: two targets, three rules", () => {
	const providers = ["claude", "codex"];

	test("1. env web, queue q, P1 -> laptop; the rule's mode wins over the target's", () => {
		const r = route(d({ env: "web", priority: 1 }), sample(), providers);
		if (!r.ok) throw new Error(r.reason);
		expect(r.target).toBe("laptop");
		expect(r.rule).toBe(3);
		expect(r.agent).toEqual({ provider: "claude", mode: "auto" });
		expect(r.binding).toEqual({ name: "web", dir, allowSetup: true });
		expect(decisionLine(r, "box")).toBe(
			"target laptop on local, provider claude, mode auto (runner box, rule 3)",
		);
	});

	test("2. env ml -> gpu on its host; the instruction's mode fills the open field", () => {
		const r = route(d({ env: "ml", mode: "plan" }), sample(), providers);
		if (!r.ok) throw new Error(r.reason);
		expect(r.target).toBe("gpu");
		expect(r.host).toBe("gpu-box:6767");
		expect(r.labels).toEqual({ pool: "gpu" });
		expect(r.agent).toEqual({ provider: "codex", mode: "plan" });
		expect(r.why).toContain(
			"provider codex from target, mode plan from instruction",
		);
		expect(decisionLine(r, "box")).toStartWith(
			"target gpu on gpu-box:6767, provider codex",
		);
	});

	test("3. a label the user keeps off this machine -> declined by rule 1", () => {
		const r = route(
			d({ env: "ml", labels: ["secret-project"] }),
			sample(),
			providers,
		);
		expect(r).toMatchObject({
			ok: false,
			reason: "declined by rule 1: not on this machine",
		});
	});

	test("4. priority 3 on queue q matches no rule -> declined with the facts", () => {
		const r = route(d({ env: "web", priority: 3 }), sample(), providers);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe(
			"no routing rule matches (env web, queue q, stage work, type task, priority 3)",
		);
		expect(r.why).toEqual([
			`environment web is bound to ${dir}`,
			"rule 1 skipped: no label secret-project",
			"rule 2 skipped: env web is not ml",
			"rule 3 skipped: priority 3 is above 2",
		]);
	});

	test("an unbound environment is declined before any rule", () => {
		const r = route(d({ env: "mobile" }), sample(), providers);
		expect(r).toMatchObject({
			ok: false,
			reason: "environment mobile is not bound on this runner",
		});
	});

	test("the instruction's provider must be one the runner offers", () => {
		const routing = sample();
		delete routing.targets.laptop?.provider;
		const r = route(d({ env: "web", provider: "gemini" }), routing, providers);
		expect(r).toMatchObject({
			ok: false,
			reason: "provider gemini is not offered by this runner",
		});
		const ok = route(d({ env: "web", provider: "codex" }), routing, providers);
		expect(ok.ok && ok.agent.provider).toBe("codex");
	});
});

describe("implicit routing (the old flags)", () => {
	const flags = { agent: { provider: "claude", mode: "auto" } };

	test("work goes to target default with the flag agent", () => {
		const r = route(d(), implicitRouting(flags, "h:1"), ["claude"]);
		if (!r.ok) throw new Error(r.reason);
		expect(r).toMatchObject({ target: "default", host: "h:1", rule: 1 });
		expect(r.agent).toEqual({ provider: "claude", mode: "auto" });
	});

	test("the instruction's provider beats --provider, as before", () => {
		const r = route(d({ provider: "codex" }), implicitRouting(flags), [
			"claude",
			"codex",
		]);
		expect(r.ok && r.agent).toEqual({ provider: "codex", mode: "auto" });
	});

	test("enrichment needs the assistant", () => {
		const e = { ...d(), stage: "enrich_input" as const };
		expect(route(e, implicitRouting(flags), ["claude"])).toMatchObject({
			ok: false,
			reason: "declined by rule 2: no assistant agent configured",
		});
		const withAssistant = implicitRouting({
			...flags,
			assistant: { provider: "codex" },
		});
		const r = route(e, withAssistant, ["claude", "codex"]);
		expect(r.ok && r.agent).toEqual({ provider: "codex" });
	});

	test("a named environment falls back to --workdir/--repo", () => {
		const r = route(d({ env: "web" }), implicitRouting(flags), ["claude"]);
		expect(r.ok && r.binding).toBeUndefined();
		expect(r.ok).toBe(true);
	});
});

describe("the provider is never empty (paseo run needs --provider)", () => {
	// The production case (mm-um2m): implicit routing, no --provider flag.
	const bare = implicitRouting({ agent: {} });

	test("no layer sets it: the first offered provider; the line names it", () => {
		const r = route(d(), bare, ["claude"]);
		if (!r.ok) throw new Error(r.reason);
		expect(r.agent.provider).toBe("claude");
		expect(decisionLine(r, "box")).toBe(
			"target default on local, provider claude (runner box, rule 1)",
		);
		expect(r.why.join("\n")).toContain("provider claude from runner providers");
	});

	test("the runner default comes before the provider list", () => {
		const r = route(d(), bare, ["claude", "codex"], { agentProvider: "codex" });
		expect(r.ok && r.agent.provider).toBe("codex");
	});

	test("a provider whose check failed is skipped", () => {
		const r = route(d(), bare, ["codex", "claude"], {
			agentProvider: "codex",
			available: { codex: false, claude: true },
		});
		expect(r.ok && r.agent.provider).toBe("claude");
	});

	test("none available: decline with the reason", () => {
		const r = route(d(), bare, ["claude"], { available: { claude: false } });
		expect(r).toMatchObject({
			ok: false,
			reason: "no provider available on this runner (offered: claude)",
		});
		expect(route(d(), bare, [])).toMatchObject({ ok: false });
	});

	test("a rule's provider still wins", () => {
		const r = route(d({ env: "ml" }), sample(), ["claude", "codex"], {
			available: { codex: false },
		});
		expect(r.ok && r.agent.provider).toBe("codex");
	});
});

test("parseRouting names the bad field", () => {
	const bad = (v: unknown) => {
		try {
			parseRouting(v, "routing.json");
			return "ok";
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			return (error as Error).message;
		}
	};
	expect(bad({ environments: { web: { dir: "rel" } } })).toBe(
		"routing.json: environments.web.dir must be an absolute path",
	);
	expect(bad({ rules: [{ match: {} }] })).toBe(
		"routing.json: rules[1] needs either target or decline",
	);
	expect(bad({ rules: [{ match: { stage: "x" }, target: "a" }] })).toContain(
		"rules[1].match.stage must be one of",
	);
	expect(bad({ targets: { a: { capacity: 0 } } })).toBe(
		"routing.json: targets.a.capacity must be a positive integer",
	);
	expect(bad(SAMPLE)).toBe("ok");
});

test("lintRouting: unknown targets, unbound environments, queues nobody takes", () => {
	const routing = parseRouting({
		targets: { a: {} },
		environments: { web: { dir: "/nonexistent/mm-web" } },
		rules: [
			{ match: { env: "ml" }, target: "a" },
			{ match: { queue: "q" }, target: "b" },
		],
	});
	expect(lintRouting(routing, { queues: ["q"] })).toEqual([
		"rule 1: environment ml is not bound",
		"rule 2: unknown target b",
		"queue q: no rule sends its work to a target",
		"environment web: /nonexistent/mm-web does not exist",
	]);
	expect(lintRouting(sample(), { queues: ["q"] })).toEqual([]);
});
