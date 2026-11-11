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
	RunnerDiagnostics,
	RunnerInFlight,
	RunnerState,
} from "@mastermind/core";
import type { RunnerSettings } from "./config.ts";
import type { DoctorReport } from "./doctor.ts";
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

/** Result of one environment check run. */
export type Checks = RunnerDiagnostics["checks"];

export type CheckRunDeps = {
	/** Run the paseo CLI; resolves with exit code and stdout. */
	paseo?: (args: string[]) => Promise<{ code: number; stdout: string }>;
	exists?: (path: string) => boolean;
	now?: () => Date;
};

async function paseoCli(
	args: string[],
	host?: string,
): Promise<{ code: number; stdout: string }> {
	try {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env))
			if (v !== undefined && k !== "PASEO_AGENT_ID" && k !== "PASEO_AGENT_CWD")
				env[k] = v;
		const proc = Bun.spawn(
			["paseo", ...args, ...(host ? ["--host", host] : [])],
			{ env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
		);
		const timer = setTimeout(() => proc.kill(), 10_000);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		clearTimeout(timer);
		return { code, stdout };
	} catch {
		return { code: 127, stdout: "" };
	}
}

/** Providers the runner may start: its list plus the agent's default. */
function providersOf(s: RunnerSettings): string[] {
	return [
		...new Set([
			...s.providers,
			...(s.agent.provider ? [s.agent.provider] : []),
		]),
	];
}

/** Paseo daemon reachable, providers available, workdir present. */
export async function runChecks(
	s: RunnerSettings,
	opts: { paseoHost?: string } & CheckRunDeps = {},
): Promise<Checks> {
	const paseo = opts.paseo ?? ((a) => paseoCli(a, opts.paseoHost));
	const exists = opts.exists ?? existsSync;
	const ls = await paseo(["ls", "--json"]);
	const daemon = ls.code === 0;
	const providers: Record<string, boolean> = {};
	if (daemon) {
		const res = await paseo(["provider", "ls", "--json"]);
		let list: { provider?: string; status?: string }[] = [];
		try {
			list = res.code === 0 ? JSON.parse(res.stdout || "[]") : [];
		} catch {}
		for (const p of providersOf(s))
			providers[p] = list.some(
				(x) => x.provider === p && x.status === "available",
			);
	} else for (const p of providersOf(s)) providers[p] = false;
	return {
		paseo: daemon,
		providers,
		workdir: s.workdir ? exists(s.workdir) : null,
		checkedAt: (opts.now?.() ?? new Date()).toISOString(),
	};
}

/** What is wrong, each with how to fix it. Empty: all good. */
export function problems(
	c: Checks,
	s: RunnerSettings,
): { problem: string; fix: string }[] {
	const out: { problem: string; fix: string }[] = [];
	if (c.paseo === false)
		out.push({
			problem: "the Paseo daemon does not answer (paseo ls failed)",
			fix: "start it: paseo daemon start (or check --paseo-host)",
		});
	for (const [p, ok] of Object.entries(c.providers))
		if (!ok && c.paseo)
			out.push({
				problem: `provider ${p} is not available in Paseo`,
				fix: `log in to ${p} on this machine, then check: paseo provider ls`,
			});
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
			...(this.secrets ? { secrets: this.secrets } : {}),
			...(this.lastDoctor ? { lastDoctor: this.lastDoctor } : {}),
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
