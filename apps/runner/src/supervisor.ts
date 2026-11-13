/**
 * The runner as two processes (mm-210.88). `mastermind-runner start` is the
 * SUPERVISOR: it holds runner.pid (lock.ts), starts ONE WORKER (the runner
 * loop, cli.ts runStart) and watches it.
 *
 * Prior art: the GitHub Actions self-hosted runner (Runner.Listener stays,
 * updates itself by default, finishes the running job first; Runner.Worker
 * runs the job) and the Paseo daemon (a supervisor restarts its worker).
 *
 *   update     every 5 min the supervisor reads the server version. Another
 *              version (auto-update on, or the pinned one): download it next
 *              to the executable, check sha256 and `--version` (update.ts),
 *              then SIGUSR2 the worker: it takes no new work, lets the running
 *              tasks finish (heartbeats go on), exits 75. Then the new binary
 *              replaces the old one (kept for a rollback) and a new worker
 *              starts. Never two workers at once: one session at a time.
 *   rollback   the new worker crashes 3 times within 10 min: the kept binary
 *              comes back, 'update to <v> rolled back: <why>'; that version is
 *              not tried again.
 *   crash      a worker exit other than 0, 2, 3, 4, 75: start again after
 *              1 s, 5 s, 30 s, then every 5 min.
 *   stop       SIGTERM or SIGINT: passed to the worker (it gives its work
 *              back); the supervisor ends with it.
 */
import { shortVersion } from "@mastermind/core";

/** Worker exit codes (cli.ts EXIT). */
export const WORKER_EXIT = {
	ok: 0,
	usage: 2,
	revoked: 3,
	superseded: 4,
	restart: 75,
} as const;

/** The exit codes the supervisor does not restart: it ends with them. */
const FINAL = new Set<number>([
	WORKER_EXIT.ok,
	WORKER_EXIT.usage,
	WORKER_EXIT.revoked,
	WORKER_EXIT.superseded,
]);

/** Waits before restarting a crashed worker: 1 s, 5 s, 30 s, then every 5 min. */
export const CRASH_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000] as const;
/** A worker that ran this long resets the back-off. */
export const STABLE_MS = 10 * 60_000;
/** Crashes of a new version within this window ... */
export const ROLLBACK_WINDOW_MS = 10 * 60_000;
/** ... this many times: back to the previous binary. */
export const ROLLBACK_CRASHES = 3;
/** How often the supervisor reads the server version. */
export const UPDATE_CHECK_MS = 5 * 60_000;

/** Auto-update mode: on (default), off, or held at one version. */
export type AutoUpdateMode =
	| { kind: "on" }
	| { kind: "off"; why?: string }
	| { kind: "pin"; version: string };

export type WorkerProcess = {
	pid: number;
	/** The exit code (a signal: 128 + n, or 1). */
	exited: Promise<number>;
	kill(signal: NodeJS.Signals): void;
};

export type LastUpdate = { from: string; to: string; at: string };
export type RolledBack = { to: string; back: string; why: string; at: string };

/** What the supervisor tells each worker (MASTERMIND_RUNNER_AUTO_UPDATE). */
export type SupervisorState = {
	mode: AutoUpdateMode;
	version: string;
	lastUpdate: LastUpdate | null;
	rolledBack: RolledBack | null;
	restarts: number;
};

export type SupervisorOptions = {
	/** The version of the executable in place now. */
	version: string;
	mode: AutoUpdateMode;
	/** Start a worker from the executable in place; `state` goes to it. */
	spawn: (state: SupervisorState) => WorkerProcess;
	/** The server's version; null: no answer. */
	serverVersion: () => Promise<string | null>;
	/** Download and check a version (update.ts stageUpdate); its version. */
	stage: () => Promise<{ version: string }>;
	/** Put the staged binary in place, keep the old one. */
	install: () => Promise<void>;
	/** Drop a staged binary that will not be used. */
	discard: () => Promise<void>;
	/** Put the kept binary back; false: none is kept. */
	rollback: () => Promise<boolean>;
	log: (line: string) => void;
	/** Aborts: stop the worker (SIGTERM) and end. */
	signal: AbortSignal;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	checkEveryMs?: number;
};

/** One line for status, doctor and debug state. */
export function autoUpdateLine(s: SupervisorState): string {
	const m = s.mode;
	let line =
		m.kind === "on"
			? "auto-update on"
			: m.kind === "pin"
				? `auto-update pinned to ${shortVersion(m.version)}`
				: `auto-update off${m.why ? ` (${m.why})` : ""}`;
	if (s.lastUpdate)
		line += `, last update ${shortVersion(s.lastUpdate.from)} -> ${shortVersion(s.lastUpdate.to)} at ${s.lastUpdate.at}`;
	if (s.rolledBack)
		line += `; update to ${shortVersion(s.rolledBack.to)} rolled back to ${shortVersion(s.rolledBack.back)} at ${s.rolledBack.at}: ${s.rolledBack.why}`;
	if (s.restarts) line += `; worker restarts ${s.restarts}`;
	return line;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Run workers until one ends with a final code (0, 2, 3, 4) or `signal`
 * aborts; the result is the exit code for the supervisor.
 */
export async function supervise(o: SupervisorOptions): Promise<number> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? defaultSleep;
	const every = o.checkEveryMs ?? UPDATE_CHECK_MS;
	const state: SupervisorState = {
		mode: o.mode,
		version: o.version,
		lastUpdate: null,
		rolledBack: null,
		restarts: 0,
	};
	/** Versions that were rolled back: not tried again. */
	const bad = new Set<string>();
	/** A staged binary waits for the worker to drain. */
	let staged: string | null = null;
	/** Set after an update: the version before it, and when. */
	let probation: { back: string; until: number } | null = null;
	let crashes: number[] = [];
	let consecutive = 0;
	let checking = false;

	const wanted = (server: string): boolean => {
		if (server === state.version || bad.has(server)) return false;
		if (o.mode.kind === "off") return false;
		if (o.mode.kind === "pin") return server === o.mode.version;
		return true;
	};

	for (;;) {
		if (o.signal.aborted) return WORKER_EXIT.ok;
		const w = o.spawn({ ...state });
		const startedAt = now();
		o.log(
			`supervisor: worker PID ${w.pid} started (${shortVersion(state.version)}; ${autoUpdateLine(state)})`,
		);
		let code: number | null = null;
		const exited = w.exited.then((c) => {
			code = c;
		});
		const stop = () => w.kill("SIGTERM");
		o.signal.addEventListener("abort", stop, { once: true });

		// Look for a new version while the worker runs.
		const tick = async () => {
			if (checking || staged || code !== null || o.signal.aborted) return;
			checking = true;
			try {
				const server = await o.serverVersion();
				if (!server || !wanted(server)) return;
				const s = await o.stage();
				if (code !== null || o.signal.aborted) {
					await o.discard();
					return;
				}
				if (!wanted(s.version)) {
					await o.discard();
					return;
				}
				staged = s.version;
				o.log(
					`supervisor: update ${shortVersion(state.version)} -> ${shortVersion(s.version)} ready; the worker takes no new work and ends when its running tasks finish`,
				);
				w.kill("SIGUSR2");
			} catch (error) {
				o.log(
					`error: auto-update failed: ${error instanceof Error ? error.message : error}; the runner keeps running ${shortVersion(state.version)}`,
				);
			} finally {
				checking = false;
			}
		};
		const watch = new AbortController();
		const both = AbortSignal.any([watch.signal, o.signal]);
		const loop = (async () => {
			if (o.mode.kind === "off") return;
			await tick();
			while (!both.aborted) {
				await sleep(every, both);
				if (!both.aborted) await tick();
			}
		})();
		await exited;
		watch.abort();
		await loop;
		o.signal.removeEventListener("abort", stop);
		const c = code as number | null;
		const exit = c ?? 1;

		if (o.signal.aborted) {
			if (staged) await o.discard();
			return FINAL.has(exit) ? exit : WORKER_EXIT.ok;
		}
		if (exit === WORKER_EXIT.restart) {
			if (staged) {
				const to = staged;
				staged = null;
				try {
					await o.install();
				} catch (error) {
					await o.discard();
					o.log(
						`error: auto-update to ${shortVersion(to)} failed: ${error instanceof Error ? error.message : error}; the runner keeps running ${shortVersion(state.version)}`,
					);
					continue;
				}
				const from = state.version;
				state.lastUpdate = { from, to, at: iso(now()) };
				state.version = to;
				probation = { back: from, until: now() + ROLLBACK_WINDOW_MS };
				crashes = [];
				consecutive = 0;
				o.log(
					`supervisor: updated ${shortVersion(from)} -> ${shortVersion(to)}; starting the new worker`,
				);
			}
			continue;
		}
		if (staged) {
			staged = null;
			await o.discard();
		}
		if (FINAL.has(exit)) {
			o.log(`supervisor: worker ended (exit ${exit})`);
			return exit;
		}

		// A crash.
		const t = now();
		state.restarts++;
		if (t - startedAt >= STABLE_MS) consecutive = 0;
		consecutive++;
		crashes = [...crashes, t].filter((x) => t - x < ROLLBACK_WINDOW_MS);
		if (probation && t > probation.until) probation = null;
		if (probation && crashes.length >= ROLLBACK_CRASHES) {
			const failed = state.version;
			const back = probation.back;
			const why = `the worker crashed ${crashes.length} times within ${ROLLBACK_WINDOW_MS / 60_000} min (last exit ${exit})`;
			probation = null;
			if (await o.rollback()) {
				bad.add(failed);
				state.version = back;
				state.rolledBack = { to: failed, back, why, at: iso(t) };
				crashes = [];
				consecutive = 0;
				o.log(
					`error: update to ${shortVersion(failed)} rolled back to ${shortVersion(back)}: ${why}`,
				);
				continue;
			}
			o.log(
				`error: update to ${shortVersion(failed)} crashes (${why}) and no previous binary is kept`,
			);
		}
		const wait =
			CRASH_BACKOFF_MS[Math.min(consecutive, CRASH_BACKOFF_MS.length) - 1] ??
			CRASH_BACKOFF_MS[0];
		o.log(
			`error: worker exited ${exit}; restart ${consecutive} in ${wait / 1000} s`,
		);
		await sleep(wait, o.signal);
	}
}

export type DrainOptions = {
	/** Tasks running now (accepted offers included). */
	running: () => number;
	/** Take no new work (readiness: not ready). */
	hold: () => void;
	/** Every task finished: end the worker with EXIT.restart. */
	done: () => void;
	log: (line: string) => void;
	/** The worker stops for another reason: give up. */
	signal: AbortSignal;
	pollMs?: number;
	/** Say 'still waiting' this often. */
	sayEveryMs?: number;
	now?: () => number;
};

/**
 * The worker's side of an update (SIGUSR2): no new work, the running tasks
 * finish (their heartbeats go on; none is stopped, however long it takes),
 * then `done`. Resolves true when `done` ran.
 */
export async function drainWorker(o: DrainOptions): Promise<boolean> {
	const now = o.now ?? Date.now;
	const poll = o.pollMs ?? 2_000;
	const every = o.sayEveryMs ?? 15 * 60_000;
	o.hold();
	o.log(
		`auto-update: no new work; this worker ends when its ${o.running()} running task(s) finish`,
	);
	let said = now();
	while (!o.signal.aborted && o.running() > 0) {
		await defaultSleep(poll, o.signal);
		if (now() - said >= every && o.running() > 0) {
			said = now();
			o.log(
				`auto-update: still waiting for ${o.running()} running task(s); none is stopped`,
			);
		}
	}
	if (o.signal.aborted) return false;
	o.done();
	return true;
}
