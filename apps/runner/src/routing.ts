/**
 * User-controlled routing: which Paseo (target) runs a dispatch, with which
 * agent, in which local checkout. The instruction (the dispatch) brings hard
 * requirements, never agent settings (mm-210.84); the user who owns this
 * runner brings the rules and the agent. Decision order:
 *
 *   a. hard requirements of the instruction: a named environment must be bound
 *      here (plus requires and secrets, see check.ts): met, or declined
 *   b. the user's rules, in order, first match wins: a target, or decline
 *   c. agent fields: rule, then target, then the stage default; first set
 *      wins. An old server's env.agent / env.provider is ignored (mm-210.84).
 *      The provider is never left empty: then the runner's default provider,
 *      then the first offered provider whose check did not fail, then the
 *      first provider Paseo reports ready (Paseo has no default provider);
 *      none: decline. No mode set: Paseo's default mode of that provider.
 *      Where the runner's Paseo is the target's, the choice is checked
 *      against it: provider ready, enabled and not logged out, mode in its
 *      modes, model in its models; else decline with Paseo's reason
 *   d. no rule matches: decline with the reason (Mastermind gets the bead back)
 *
 * The file is `routing.json` next to the runner config (no secrets in it).
 * Without one, the old flags make an implicit config: one target `default`
 * (--paseo-host), rules "work -> default" and "enrichment -> default when an
 * assistant is set", and --provider/--mode/--assistant-provider as defaults.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
	Dispatch,
	DispatchStage,
	PaseoProviderState,
} from "@mastermind/core";
import { DISPATCH_STAGES } from "@mastermind/core";
import {
	type AgentSettings,
	ConfigError,
	type RunnerSettings,
} from "./config.ts";

/** A named Paseo destination. */
export type Target = {
	/** `paseo --host`; absent: the local daemon. */
	paseoHost?: string;
	/** Paseo provider, or provider/model. */
	provider?: string;
	model?: string;
	mode?: string;
	/** Extra labels on every agent this target starts. */
	labels?: Record<string, string>;
	/** Most agents at once on this target (the runner capacity still applies). */
	capacity?: number;
};

/** The user's binding of a Mastermind environment name to this machine. */
export type EnvBinding = {
	/** Absolute path of the checkout. */
	dir: string;
	/** Run the environment's setup commands. Off by default. */
	allowSetup?: boolean;
	/**
	 * Where each declared secret comes from: `env:VAR` (or just `VAR`) reads a
	 * local env var, `file:/path` reads a file. Unlisted secrets: the env var of
	 * the same name.
	 */
	env?: Record<string, string>;
};

export type RuleMatch = {
	/** Environment name (`env.name`). */
	env?: string;
	queue?: string;
	stage?: DispatchStage;
	/** Bead type, for example `bug`. */
	type?: string;
	/** Every one of these labels is on the bead. */
	labels?: string[];
	/** Bead priority is this or more urgent (0 is the most urgent). */
	maxPriority?: number;
};

export type RouteRule = {
	match: RuleMatch;
	target: string;
	provider?: string;
	model?: string;
	mode?: string;
};
export type DeclineRule = { match: RuleMatch; decline: string };
export type Rule = RouteRule | DeclineRule;

export type Routing = {
	targets: Record<string, Target>;
	environments: Record<string, EnvBinding>;
	rules: Rule[];
	/** Agent settings per stage, used last (after the instruction's preference). */
	defaults?: Partial<Record<DispatchStage, AgentSettings>>;
	/**
	 * Built from the old flags: a named environment that is not bound falls back
	 * to --workdir / --repo instead of being declined.
	 */
	implicit?: boolean;
};

export type Decision =
	| {
			ok: true;
			target: string;
			/** `paseo --host`, absent for the local daemon. */
			host?: string;
			/** 1-based index of the rule that matched. */
			rule: number;
			agent: AgentSettings;
			labels: Record<string, string>;
			/** The bound environment, when the dispatch names one that is bound. */
			binding?: EnvBinding & { name: string };
			/** How the decision was made, one line each. */
			why: string[];
	  }
	| { ok: false; reason: string; why: string[] };

type Routable = Pick<Dispatch, "queue" | "stage" | "env"> & {
	bead: Pick<Dispatch["bead"], "type" | "labels" | "priority">;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((s) => typeof s === "string");
const isStringMap = (v: unknown): v is Record<string, string> =>
	isObj(v) && Object.values(v).every((s) => typeof s === "string");

/** The routing from the old flags. */
export function implicitRouting(
	s: Pick<RunnerSettings, "agent" | "assistant">,
	paseoHost?: string,
): Routing {
	const rules: Rule[] = [{ match: { stage: "work" }, target: "default" }];
	rules.push(
		s.assistant
			? { match: {}, target: "default" }
			: { match: {}, decline: "no assistant agent configured" },
	);
	return {
		targets: { default: paseoHost ? { paseoHost } : {} },
		environments: {},
		rules,
		defaults: {
			work: s.agent,
			...(s.assistant
				? { enrich_input: s.assistant, enrich_output: s.assistant }
				: {}),
		},
		implicit: true,
	};
}

/** Throws ConfigError unless `v` is a routing config. */
export function parseRouting(v: unknown, where = "routing"): Routing {
	const fail = (what: string): never => {
		throw new ConfigError(`${where}: ${what}`);
	};
	if (!isObj(v)) return fail("not an object");
	const targets = v.targets ?? {};
	const environments = v.environments ?? {};
	const rules = v.rules ?? [];
	if (!isObj(targets)) fail("targets must be an object");
	if (!isObj(environments)) fail("environments must be an object");
	if (!Array.isArray(rules)) fail("rules must be a list");
	for (const [name, t] of Object.entries(targets as object)) {
		const at = `targets.${name}`;
		if (!isObj(t)) fail(`${at} must be an object`);
		for (const k of ["paseoHost", "provider", "model", "mode"])
			if (t[k] !== undefined && typeof t[k] !== "string")
				fail(`${at}.${k} must be a string`);
		if (t.labels !== undefined && !isStringMap(t.labels))
			fail(`${at}.labels must map strings to strings`);
		if (
			t.capacity !== undefined &&
			(!Number.isInteger(t.capacity) || (t.capacity as number) < 1)
		)
			fail(`${at}.capacity must be a positive integer`);
	}
	for (const [name, b] of Object.entries(environments as object)) {
		const at = `environments.${name}`;
		if (!isObj(b)) fail(`${at} must be an object`);
		if (typeof b.dir !== "string" || !isAbsolute(b.dir))
			fail(`${at}.dir must be an absolute path`);
		if (b.allowSetup !== undefined && typeof b.allowSetup !== "boolean")
			fail(`${at}.allowSetup must be true or false`);
		if (b.env !== undefined && !isStringMap(b.env))
			fail(`${at}.env must map secret names to sources`);
	}
	for (const [i, r] of (rules as unknown[]).entries()) {
		const at = `rules[${i + 1}]`;
		if (!isObj(r) || !isObj(r.match)) return fail(`${at}.match is missing`);
		const m = r.match;
		for (const k of ["env", "queue", "type"])
			if (m[k] !== undefined && typeof m[k] !== "string")
				fail(`${at}.match.${k} must be a string`);
		if (
			m.stage !== undefined &&
			!DISPATCH_STAGES.includes(m.stage as DispatchStage)
		)
			fail(`${at}.match.stage must be one of ${DISPATCH_STAGES.join(", ")}`);
		if (m.labels !== undefined && !isStrings(m.labels))
			fail(`${at}.match.labels must be strings`);
		if (m.maxPriority !== undefined && !Number.isInteger(m.maxPriority))
			fail(`${at}.match.maxPriority must be an integer`);
		const route = typeof r.target === "string";
		const decline = typeof r.decline === "string";
		if (route === decline) fail(`${at} needs either target or decline`);
		for (const k of ["provider", "model", "mode"])
			if (r[k] !== undefined && typeof r[k] !== "string")
				fail(`${at}.${k} must be a string`);
	}
	return {
		targets: targets as Record<string, Target>,
		environments: environments as Record<string, EnvBinding>,
		rules: rules as Rule[],
		...(isObj(v.defaults)
			? { defaults: v.defaults as Routing["defaults"] }
			: {}),
	};
}

/** `$MASTERMIND_RUNNER_ROUTING`, else `routing.json` next to the runner config. */
export function routingPath(
	configFile: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return (
		env.MASTERMIND_RUNNER_ROUTING || join(dirname(configFile), "routing.json")
	);
}

/** The routing file, or the implicit routing of the old flags when there is none. */
export async function loadRouting(
	path: string,
	s: Pick<RunnerSettings, "agent" | "assistant">,
	paseoHost?: string,
): Promise<{ routing: Routing; source: string }> {
	if (!existsSync(path))
		return { routing: implicitRouting(s, paseoHost), source: "flags" };
	let v: unknown;
	try {
		v = JSON.parse(await Bun.file(path).text());
	} catch (error) {
		throw new ConfigError(`${path}: not JSON (${error})`);
	}
	return { routing: parseRouting(v, path), source: path };
}

const show = (m: RuleMatch) =>
	Object.keys(m).length ? JSON.stringify(m) : "{} (anything)";

/** Why `d` does not match `m`, or null when it does. */
export function mismatch(m: RuleMatch, d: Routable): string | null {
	if (m.env !== undefined && m.env !== d.env.name)
		return `env ${d.env.name ?? "-"} is not ${m.env}`;
	if (m.queue !== undefined && m.queue !== d.queue)
		return `queue ${d.queue} is not ${m.queue}`;
	if (m.stage !== undefined && m.stage !== d.stage)
		return `stage ${d.stage} is not ${m.stage}`;
	if (m.type !== undefined && m.type !== d.bead.type)
		return `type ${d.bead.type} is not ${m.type}`;
	const missing = (m.labels ?? []).filter((l) => !d.bead.labels.includes(l));
	if (missing.length) return `no label ${missing.join(", ")}`;
	if (m.maxPriority !== undefined && d.bead.priority > m.maxPriority)
		return `priority ${d.bead.priority} is above ${m.maxPriority}`;
	return null;
}

/**
 * The mode of an unattended agent when no layer sets one and Paseo does not
 * report (an old check, or a target on another host): a mode that does not
 * stop to ask for permission. Undefined: the provider's own default.
 */
const UNATTENDED_MODE: Record<string, string> = { claude: "auto" };
export function defaultMode(provider: string): string | undefined {
	return UNATTENDED_MODE[baseOf(provider)];
}

const baseOf = (provider: string) => provider.split("/")[0] as string;

/** Why Paseo cannot run `provider` now; null: it can (or Paseo does not list it and has no say). */
export function paseoRefusal(
	x: PaseoProviderState | undefined,
	provider: string,
): string | null {
	if (!x) return `provider ${provider} is not listed by Paseo`;
	if (!x.enabled) return `provider ${provider} is disabled in Paseo`;
	if (x.status !== "ready")
		return `provider ${provider} is ${x.status} in Paseo${x.error ? `: ${x.error}` : ""}`;
	if (x.loggedIn === false)
		return `provider ${provider} is not logged in (Paseo)`;
	return null;
}

/** Where the provider comes from when no layer sets one. */
export type ProviderFallback = {
	/** The runner's own default (`settings.agent.provider`). */
	agentProvider?: string;
	/** Provider check results (diagnostics); false: not available. */
	available?: Record<string, boolean>;
	/**
	 * What the runner's Paseo reports (diagnostics, mm-210.84) and its host
	 * (undefined: local). Used for targets on that host only.
	 */
	paseo?: { host?: string; providers: PaseoProviderState[] };
};

/** Pick the target and agent for a dispatch. Pure: no files, no commands. */
export function route(
	d: Routable,
	routing: Routing,
	providers: string[],
	fallback: ProviderFallback = {},
): Decision {
	const why: string[] = [];
	const name = d.env.name;
	let binding: (EnvBinding & { name: string }) | undefined;
	if (name) {
		const b = routing.environments[name];
		if (b) {
			binding = { name, ...b };
			why.push(`environment ${name} is bound to ${b.dir}`);
		} else if (!routing.implicit) {
			return {
				ok: false,
				reason: `environment ${name} is not bound on this runner`,
				why,
			};
		} else why.push(`environment ${name}: no binding, --workdir/--repo apply`);
	}

	let index = 0;
	let rule: Rule | undefined;
	for (const r of routing.rules) {
		index++;
		const no = mismatch(r.match, d);
		if (!no) {
			rule = r;
			break;
		}
		why.push(`rule ${index} skipped: ${no}`);
	}
	const facts = `env ${name ?? "-"}, queue ${d.queue}, stage ${d.stage}, type ${d.bead.type}, priority ${d.bead.priority}`;
	if (!rule)
		return { ok: false, reason: `no routing rule matches (${facts})`, why };
	why.push(`rule ${index} matched: ${show(rule.match)}`);
	if ("decline" in rule)
		return {
			ok: false,
			reason: `declined by rule ${index}: ${rule.decline}`,
			why,
		};
	const target = routing.targets[rule.target];
	if (!target)
		return {
			ok: false,
			reason: `rule ${index} names unknown target ${rule.target}`,
			why,
		};

	const stageDefault = routing.defaults?.[d.stage] ?? {};
	const layers = [
		["rule", rule],
		["target", target],
		["default", stageDefault],
	] as const;
	const agent: AgentSettings = {};
	const from: string[] = [];
	for (const field of ["provider", "model", "mode"] as const) {
		for (const [layer, src] of layers) {
			const v = src[field];
			if (v) {
				agent[field] = v;
				from.push(`${field} ${v} from ${layer}`);
				break;
			}
		}
	}
	// Paseo's report counts for a target on the runner's own Paseo only.
	const paseo =
		fallback.paseo && (target.paseoHost ?? "") === (fallback.paseo.host ?? "")
			? fallback.paseo.providers
			: undefined;
	const reportOf = (p: string) => paseo?.find((x) => x.name === baseOf(p));
	if (!agent.provider) {
		const ok = (p: string) =>
			fallback.available?.[baseOf(p)] !== false &&
			(!paseo || !paseoRefusal(reportOf(p), baseOf(p)));
		const own = fallback.agentProvider;
		const p =
			own && ok(own)
				? own
				: (providers.find(ok) ??
					paseo?.find((x) => !paseoRefusal(x, x.name))?.name);
		if (!p)
			return {
				ok: false,
				reason: `no provider available on this runner (offered: ${providers.join(", ") || "none"}${
					paseo
						? `; Paseo ready: ${
								paseo
									.filter((x) => !paseoRefusal(x, x.name))
									.map((x) => x.name)
									.join(", ") || "none"
							}`
						: ""
				})`,
				why,
			};
		agent.provider = p;
		from.push(
			`provider ${p} from ${
				p === own
					? "runner default"
					: providers.includes(p)
						? "runner providers"
						: "Paseo (first ready)"
			}`,
		);
	}
	const report = reportOf(agent.provider);
	if (paseo) {
		const base = baseOf(agent.provider);
		const no = paseoRefusal(report, base);
		if (no) return { ok: false, reason: no, why };
	}
	if (!agent.mode) {
		const m = report?.defaultMode ?? defaultMode(agent.provider);
		if (m) {
			agent.mode = m;
			from.push(
				`mode ${m} (${report?.defaultMode ? "Paseo default" : "unattended default"})`,
			);
		}
	}
	if (
		report &&
		agent.mode &&
		report.modes.length &&
		!report.modes.includes(agent.mode)
	)
		return {
			ok: false,
			reason: `mode ${agent.mode} is not a mode of ${baseOf(agent.provider)} in Paseo (${report.modes.join(", ")})`,
			why,
		};
	const model =
		agent.model ??
		(agent.provider.includes("/")
			? agent.provider.slice(agent.provider.indexOf("/") + 1)
			: undefined);
	if (report && model && report.models.length && !report.models.includes(model))
		return {
			ok: false,
			reason: `model ${model} is not listed for ${baseOf(agent.provider)} in Paseo`,
			why,
		};
	if (from.length) why.push(from.join(", "));
	return {
		ok: true,
		target: rule.target,
		...(target.paseoHost ? { host: target.paseoHost } : {}),
		rule: index,
		agent,
		labels: { ...target.labels },
		...(binding ? { binding } : {}),
		why,
	};
}

/** The first report of a dispatch: where the work runs. */
export function decisionLine(
	d: Extract<Decision, { ok: true }>,
	runnerId: string,
): string {
	const parts = [
		`target ${d.target} on ${d.host ?? "local"}`,
		`provider ${d.agent.provider ?? "none"}`,
	];
	if (d.agent.mode) parts.push(`mode ${d.agent.mode}`);
	return `${parts.join(", ")} (runner ${runnerId}, rule ${d.rule})`;
}

/** Problems in the routing for this runner, one line each (for `check`). */
export function lintRouting(
	routing: Routing,
	s: Pick<RunnerSettings, "queues">,
): string[] {
	const bad: string[] = [];
	routing.rules.forEach((r, i) => {
		const at = `rule ${i + 1}`;
		if ("target" in r && !routing.targets[r.target])
			bad.push(`${at}: unknown target ${r.target}`);
		if (r.match.env && !routing.implicit && !routing.environments[r.match.env])
			bad.push(`${at}: environment ${r.match.env} is not bound`);
		if (r.match.queue && !s.queues.includes(r.match.queue))
			bad.push(
				`${at}: queue ${r.match.queue} is not one of this runner's queues`,
			);
	});
	for (const q of s.queues) {
		const takes = routing.rules.some(
			(r) =>
				"target" in r &&
				routing.targets[r.target] !== undefined &&
				(r.match.queue === undefined || r.match.queue === q) &&
				(!r.match.env || routing.implicit || routing.environments[r.match.env]),
		);
		if (!takes) bad.push(`queue ${q}: no rule sends its work to a target`);
	}
	for (const [name, b] of Object.entries(routing.environments)) {
		if (!existsSync(b.dir))
			bad.push(`environment ${name}: ${b.dir} does not exist`);
		for (const [secret, src] of Object.entries(b.env ?? {}))
			if (src.startsWith("file:") && !existsSync(src.slice(5)))
				bad.push(
					`environment ${name}: secret ${secret}: ${src.slice(5)} does not exist`,
				);
	}
	return bad;
}
