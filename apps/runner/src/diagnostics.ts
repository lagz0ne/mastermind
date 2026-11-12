/**
 * The runner's view of itself (mm-210.43), for troubleshooting from
 * Mastermind and locally:
 *
 *   publish  mm.u.<account>.r.<runner>.status   every 15 s and on change
 *   write    <config dir>/status.json            same snapshot, for `status`
 *
 * No secrets leave the runner: log lines are redacted before they are kept.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	PaseoProviderState,
	RunnerDiagnostics,
	RunnerInFlight,
	RunnerReadiness,
	RunnerState,
} from "@mastermind/core";
import type { RunnerSettings } from "./config.ts";
import type { DoctorReport } from "./doctor.ts";
import {
	connectPaseo,
	type PaseoConnect,
	PaseoUnreachable,
	paseoMessage,
} from "./paseo/client.ts";
import type { SecretsDiagnostics } from "./secrets/needs.ts";

export const STATUS_EVERY_MS = 15_000;
export const KEEP_ERRORS = 20;

/** `status.json` next to the runner config. */
export const statusPath = (configPath: string) =>
	join(dirname(configPath), "status.json");

const SECRETS: [RegExp, string][] = [
	[/\b(mm[se]_)[A-Za-z0-9_-]+/g, "$1…"],
	[/\b(eyJ)[A-Za-z0-9_.-]{10,}/g, "$1…"],
	[
		/((?:token|credential|password|passwd|secret|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s"',}]+/gi,
		"$1…",
	],
	[/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1…@"],
	[/\b(gh[pousr]_)[A-Za-z0-9]+/g, "$1…"],
];

/** The line without credentials, tokens or passwords. */
export function redactLine(line: string): string {
	let out = line;
	for (const [re, to] of SECRETS) out = out.replace(re, to);
	return out;
}

const PROBLEM =
	/fail|error|declin|refus|lost|revok|disconnect|retry|timeout|denied|not |cannot|exited/i;

/** The report with every line redacted. */
export function redactReport(r: DoctorReport): DoctorReport {
	return {
		...r,
		steps: r.steps.map((s) => ({
			...s,
			detail: s.detail.map(redactLine),
			...(s.problem ? { problem: redactLine(s.problem) } : {}),
			...(s.fix ? { fix: redactLine(s.fix) } : {}),
		})),
	};
}

/** `doctor.json` next to the runner config: the last local doctor report. */
export const doctorPath = (configPath: string) =>
	join(dirname(configPath), "doctor.json");

export async function writeDoctor(
	configPath: string,
	r: DoctorReport,
): Promise<void> {
	const path = doctorPath(configPath);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(redactReport(r), null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(tmp, path);
}

export async function readDoctor(
	configPath: string,
): Promise<DoctorReport | null> {
	try {
		return (await Bun.file(doctorPath(configPath)).json()) as DoctorReport;
	} catch {
		return null;
	}
}

/** Is this log line worth keeping as a problem? */
export const isProblem = (line: string) => PROBLEM.test(line);

/**
 * Result of one environment check run. `why`: Paseo's own reason for each
 * false value (sent with the status; older servers ignore it).
 */
export type Checks = RunnerDiagnostics["checks"] & {
	why?: {
		paseo?: { problem: string; fix: string };
		providers?: Record<string, { problem: string; fix: string }>;
	};
};

export type CheckRunDeps = {
	/** How to reach Paseo; default: the SDK. */
	connect?: PaseoConnect;
	exists?: (path: string) => boolean;
	now?: () => Date;
};

/** Providers the runner may start: its list plus the agent's default. */
function providersOf(s: RunnerSettings): string[] {
	return [
		...new Set([
			...s.providers,
			...(s.agent.provider ? [s.agent.provider.split("/")[0] as string] : []),
		]),
	];
}

/**
 * Ask Paseo: the daemon answers, each provider is ready there, and (with
 * `login`, for --no-box: the agent runs on that daemon) its login as Paseo's
 * diagnostic shows it. A box agent logs in in the box, so `login` is off then.
 * Also: workdir present.
 */
export async function runChecks(
	s: RunnerSettings,
	opts: { paseoHost?: string; login?: boolean } & CheckRunDeps = {},
): Promise<Checks> {
	const connect = opts.connect ?? connectPaseo;
	const exists = opts.exists ?? existsSync;
	const providers: Record<string, boolean> = {};
	const why: NonNullable<Checks["why"]> = {};
	const notReady: Record<string, { problem: string; fix: string }> = {};
	const wanted = providersOf(s);
	let reported: PaseoProviderState[] | undefined;
	let daemon = false;
	try {
		const p = await connect(opts.paseoHost);
		try {
			daemon = true;
			const list = await p.providers();
			// Everything Paseo reports, for routing and /people (mm-210.84).
			reported = list.map((x) => ({
				name: x.provider,
				status: x.status,
				enabled: x.enabled,
				loggedIn: null,
				defaultMode: x.defaultMode,
				modes: x.modes,
				models: x.models,
				...(x.error ? { error: x.error } : {}),
			}));
			for (const name of wanted) {
				const x = list.find((y) => y.provider === name);
				const fix = `log in to ${name} on this machine (or install it), then check: paseo provider ls`;
				if (x?.status !== "ready" || !x.enabled) {
					providers[name] = false;
					notReady[name] = {
						problem: `provider ${name} is not available in Paseo on ${p.where}: ${
							!x
								? "not listed"
								: !x.enabled
									? "disabled"
									: `${x.status}${x.error ? ` (${x.error})` : ""}`
						}`,
						fix,
					};
					continue;
				}
				providers[name] = true;
				if (!opts.login) continue;
				const l = await p.login(name).catch(() => null);
				const r = reported.find((y) => y.name === name);
				if (r && l) r.loggedIn = l.loggedIn;
				if (l?.loggedIn === false) {
					providers[name] = false;
					notReady[name] = {
						problem: `provider ${name} is not logged in on ${p.where} (Paseo: loggedIn false${l.authMethod ? `, authMethod ${l.authMethod}` : ""})`,
						fix: `log ${name} in on this machine (claude: claude /login, or set CLAUDE_CODE_OAUTH_TOKEN for the Paseo daemon), then check: paseo provider diagnostic ${name}`,
					};
				}
			}
		} finally {
			await p.close();
		}
	} catch (error) {
		if (!daemon)
			why.paseo = {
				problem: `the Paseo daemon does not answer: ${paseoMessage(error)}`,
				fix:
					error instanceof PaseoUnreachable
						? error.fix
						: "start it: paseo daemon start (or check --paseo-host)",
			};
		else
			why.paseo = {
				problem: `the Paseo daemon does not answer: ${paseoMessage(error)}`,
				fix: "check the Paseo daemon: paseo daemon status",
			};
		daemon = false;
		for (const name of wanted) providers[name] = false;
	}
	if (Object.keys(notReady).length) why.providers = notReady;
	return {
		paseo: daemon,
		providers,
		workdir: s.workdir ? exists(s.workdir) : null,
		checkedAt: (opts.now?.() ?? new Date()).toISOString(),
		...(reported ? { paseoProviders: reported } : {}),
		...(Object.keys(why).length ? { why } : {}),
	};
}

/** What is wrong, each with how to fix it. Empty: all good. */
export function problems(
	c: Checks,
	s: RunnerSettings,
): { problem: string; fix: string }[] {
	const out: { problem: string; fix: string }[] = [];
	if (c.paseo === false)
		out.push(
			c.why?.paseo ?? {
				problem: "the Paseo daemon does not answer",
				fix: "start it: paseo daemon start (or check --paseo-host)",
			},
		);
	for (const [p, ok] of Object.entries(c.providers))
		if (!ok && c.paseo)
			out.push(
				c.why?.providers?.[p] ?? {
					problem: `provider ${p} is not available in Paseo`,
					fix: `log in to ${p} on this machine, then check: paseo provider ls`,
				},
			);
	if (c.workdir === false)
		out.push({
			problem: `workdir ${s.workdir} does not exist`,
			fix: "create it, or set another one: --workdir <dir> --save",
		});
	if (!s.queues.length)
		out.push({ problem: "no queues", fix: "--queue <q> --save" });
	return out;
}

/** The live state the runner loop exposes to diagnostics. */
export type LoopView = {
	inFlight(): RunnerInFlight[];
	lastNextAt: string | null;
	lastNextResult: RunnerDiagnostics["lastNextResult"];
	lastDecision: string | null;
};

/** Collects the runner's state and log; makes snapshots. */
export class Diagnostics {
	state: RunnerState = "connecting";
	natsServer: string | null = null;
	reconnects = 0;
	checks: Checks = {
		paseo: null,
		providers: {},
		workdir: null,
		checkedAt: null,
	};
	loop: LoopView | null = null;
	/** Needed and missing secret NAMES (never values); null until learned. */
	secrets: SecretsDiagnostics | null = null;
	/** The last doctor report (local or remote), redacted; null: none yet. */
	lastDoctor: DoctorReport | null = null;
	/** Worker readiness (readiness.ts); null: not evaluated (older callers). */
	readiness: RunnerReadiness | null = null;
	/** The version notice (update.ts); null: same version as the server or unknown. */
	update: string | null = null;
	/** This process's session (mm-210.79); null: not started by `start`. */
	session: { session: string; startedAt: string } | null = null;
	readonly #errors: string[] = [];
	readonly #listeners = new Set<() => void>();

	constructor(
		readonly settings: RunnerSettings,
		readonly version: string,
		readonly now: () => Date = () => new Date(),
	) {}

	/** Keep a log line when it is a problem (redacted). */
	log(line: string): void {
		if (!isProblem(line)) return;
		this.#errors.push(redactLine(line).slice(0, 500));
		if (this.#errors.length > KEEP_ERRORS) this.#errors.shift();
		this.changed();
	}

	set(state: RunnerState): void {
		if (this.state === state) return;
		this.state = state;
		this.changed();
	}

	onChange(l: () => void): () => void {
		this.#listeners.add(l);
		return () => this.#listeners.delete(l);
	}

	changed(): void {
		for (const l of this.#listeners) {
			try {
				l();
			} catch {}
		}
	}

	/** Keep `r` as lastDoctor when it is newer than the one kept. */
	doctor(r: DoctorReport | null): void {
		if (!r || (this.lastDoctor && this.lastDoctor.at >= r.at)) return;
		this.lastDoctor = redactReport(r);
		this.changed();
	}

	snapshot(): RunnerDiagnostics & {
		update?: string;
		secrets?: SecretsDiagnostics;
		lastDoctor?: DoctorReport;
	} {
		const s = this.settings;
		const inFlight = this.loop?.inFlight() ?? [];
		return {
			runner: s.id,
			version: this.version,
			at: this.now().toISOString(),
			state: this.state,
			natsServer: this.natsServer,
			reconnects: this.reconnects,
			queues: s.queues,
			capacity: s.capacity,
			running: inFlight.length,
			inFlight,
			lastNextAt: this.loop?.lastNextAt ?? null,
			lastNextResult: this.loop?.lastNextResult ?? null,
			lastDecision: this.loop?.lastDecision ?? null,
			checks: this.checks,
			lastErrors: [...this.#errors],
			...(this.session ?? {}),
			...(this.update ? { update: this.update } : {}),
			...(this.secrets ? { secrets: this.secrets } : {}),
			...(this.lastDoctor ? { lastDoctor: this.lastDoctor } : {}),
			...(this.readiness
				? {
						readiness: {
							...this.readiness,
							failedChecks: this.readiness.failedChecks.map((c) => ({
								...c,
								problem: redactLine(c.problem),
								...(c.fix ? { fix: redactLine(c.fix) } : {}),
							})),
						},
					}
				: {}),
		};
	}
}

export type ReporterOptions = {
	diagnostics: Diagnostics;
	/** Send one snapshot (NATS publish); errors are swallowed. */
	publish: (d: RunnerDiagnostics) => void;
	/** Where to write status.json; none: no file. */
	file?: string;
	/** Re-run the checks before each periodic send. */
	check?: () => Promise<Checks>;
	everyMs?: number;
	/** Coalesce change bursts. Default 500 ms. */
	debounceMs?: number;
};

async function writeStatus(path: string, d: RunnerDiagnostics) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

/** Send a snapshot now, every `everyMs`, and shortly after each change. */
export function startReporter(o: ReporterOptions): {
	send(): Promise<void>;
	stop(): Promise<void>;
} {
	let pending: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let chain = Promise.resolve();
	const send = () => {
		chain = chain.then(async () => {
			const d = o.diagnostics.snapshot();
			try {
				o.publish(d);
			} catch {}
			if (o.file) await writeStatus(o.file, d).catch(() => {});
		});
		return chain;
	};
	const tick = async () => {
		if (o.check) {
			try {
				o.diagnostics.checks = await o.check();
			} catch {}
		}
		if (!stopped) await send();
	};
	const off = o.diagnostics.onChange(() => {
		if (stopped || pending) return;
		pending = setTimeout(() => {
			pending = null;
			void send();
		}, o.debounceMs ?? 500);
	});
	const timer = setInterval(() => void tick(), o.everyMs ?? STATUS_EVERY_MS);
	void tick();
	return {
		send,
		async stop() {
			stopped = true;
			off();
			clearInterval(timer);
			if (pending) clearTimeout(pending);
			await send();
		},
	};
}
