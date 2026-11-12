import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Dispatch, PaseoProviderState } from "@mastermind/core";
import { ConfigError } from "../src/config.ts";
import {
	decisionLine,
	defaultMode,
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

	test("2. env ml -> gpu on its host; an old server's mode is ignored (mm-210.84)", () => {
		const r = route(d({ env: "ml", mode: "plan" }), sample(), providers);
		if (!r.ok) throw new Error(r.reason);
		expect(r.target).toBe("gpu");
		expect(r.host).toBe("gpu-box:6767");
		expect(r.labels).toEqual({ pool: "gpu" });
		expect(r.agent).toEqual({ provider: "codex" });
		expect(r.why).toContain("provider codex from target");
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

	test("an old server's provider never chooses the agent (mm-210.84)", () => {
		const routing = sample();
		delete routing.targets.laptop?.provider;
		const r = route(d({ env: "web", provider: "gemini" }), routing, providers);
		expect(r.ok && r.agent.provider).toBe("claude");
		expect(r.ok && r.why.join("\n")).not.toContain("gemini");
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

	test("--provider wins over an old server's provider (mm-210.84)", () => {
		const r = route(d({ provider: "codex" }), implicitRouting(flags), [
			"claude",
			"codex",
		]);
		expect(r.ok && r.agent).toEqual({ provider: "claude", mode: "auto" });
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
			"target default on local, provider claude, mode auto (runner box, rule 1)",
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

	test("claude without a mode gets auto (a mode that does not ask); a set mode stays", () => {
		const r = route(d(), bare, ["claude"]);
		expect(r.ok && r.agent.mode).toBe("auto");
		expect(r.why.join("\n")).toContain("mode auto (unattended default)");
		const set = route(
			d(),
			implicitRouting({ agent: { mode: "bypassPermissions" } }),
			["claude"],
		);
		expect(set.ok && set.agent.mode).toBe("bypassPermissions");
		expect(defaultMode("claude/claude-haiku-5-5")).toBe("auto");
		expect(defaultMode("codex")).toBeUndefined();
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

describe("the runner asks Paseo (mm-210.84)", () => {
	const bare = implicitRouting({ agent: {} });
	const claude: PaseoProviderState = {
		name: "claude",
		status: "ready",
		enabled: true,
		loggedIn: null,
		defaultMode: "acceptEdits",
		modes: ["default", "acceptEdits", "auto", "bypassPermissions"],
		models: ["opus", "sonnet"],
	};
	const codex: PaseoProviderState = {
		name: "codex",
		status: "ready",
		enabled: true,
		loggedIn: true,
		defaultMode: "auto-review",
		modes: ["auto-review", "full-access"],
		models: [],
	};
	const paseo = (...providers: PaseoProviderState[]) => ({
		paseo: { providers },
	});

	test("no mode set: Paseo's default mode of that provider", () => {
		const r = route(d(), bare, ["claude"], paseo(claude));
		if (!r.ok) throw new Error(r.reason);
		expect(r.agent).toEqual({ provider: "claude", mode: "acceptEdits" });
		expect(r.why.join("\n")).toContain("mode acceptEdits (Paseo default)");
	});

	test("no provider in the runner's settings: the first provider Paseo reports ready", () => {
		const r = route(
			d(),
			bare,
			[],
			paseo({ ...claude, status: "unavailable" }, codex),
		);
		if (!r.ok) throw new Error(r.reason);
		expect(r.agent).toEqual({ provider: "codex", mode: "auto-review" });
		expect(r.why.join("\n")).toContain(
			"provider codex from Paseo (first ready)",
		);
	});

	test("a provider Paseo reports unavailable, disabled, logged out or unknown: declined with Paseo's reason", () => {
		const own = implicitRouting({ agent: { provider: "claude" } });
		const reason = (c: PaseoProviderState | null) => {
			const r = route(d(), own, ["claude"], paseo(...(c ? [c] : [])));
			return r.ok ? "ok" : r.reason;
		};
		expect(
			reason({
				...claude,
				status: "error",
				error: "claude not found on PATH",
			}),
		).toBe("provider claude is error in Paseo: claude not found on PATH");
		expect(reason({ ...claude, enabled: false })).toBe(
			"provider claude is disabled in Paseo",
		);
		expect(reason({ ...claude, loggedIn: false })).toBe(
			"provider claude is not logged in (Paseo)",
		);
		expect(reason(null)).toBe("provider claude is not listed by Paseo");
		expect(reason(claude)).toBe("ok");
	});

	test("a mode or model Paseo does not list: declined", () => {
		// Rule 3 of the sample sets mode auto; this Paseo has no such mode.
		const noAuto = { ...claude, modes: ["default", "plan"] };
		const r = route(
			d({ env: "web", priority: 1 }),
			sample(),
			["claude"],
			paseo(noAuto),
		);
		expect(r).toMatchObject({
			ok: false,
			reason: "mode auto is not a mode of claude in Paseo (default, plan)",
		});
		const own = implicitRouting({ agent: { provider: "claude/haiku" } });
		expect(route(d(), own, ["claude"], paseo(claude))).toMatchObject({
			ok: false,
			reason: "model haiku is not listed for claude in Paseo",
		});
		const listed = implicitRouting({ agent: { provider: "claude/opus" } });
		expect(route(d(), listed, ["claude"], paseo(claude)).ok).toBe(true);
	});

	test("a target on another Paseo host is not checked against the local report", () => {
		const r = route(
			d({ env: "ml" }),
			sample(),
			["claude", "codex"],
			paseo({ ...claude, status: "unavailable" }),
		);
		expect(r.ok && r.agent.provider).toBe("codex");
	});
});
