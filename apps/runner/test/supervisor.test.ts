import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoUpdateMode, workerArgv } from "../src/cli.ts";
import { defaultSettings } from "../src/config.ts";
import {
	type AutoUpdateMode,
	autoUpdateLine,
	CRASH_BACKOFF_MS,
	drainWorker,
	type SupervisorOptions,
	type SupervisorState,
	supervise,
	WORKER_EXIT,
	type WorkerProcess,
} from "../src/supervisor.ts";
import {
	installStaged,
	previousPath,
	rollbackInstall,
	stageUpdate,
} from "../src/update.ts";

const OLD = "2f22252aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "ce20fc6bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A worker the test ends by hand; records its signals. */
class FakeWorker implements WorkerProcess {
	static next = 100;
	readonly pid = FakeWorker.next++;
	readonly signals: NodeJS.Signals[] = [];
	#end: (code: number) => void = () => {};
	readonly exited = new Promise<number>((r) => {
		this.#end = r;
	});
	constructor(
		readonly state: SupervisorState,
		readonly onSignal: (w: FakeWorker, s: NodeJS.Signals) => void,
	) {}
	kill(signal: NodeJS.Signals) {
		this.signals.push(signal);
		this.onSignal(this, signal);
	}
	exit(code: number) {
		this.#end(code);
	}
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean, what: string) {
	for (let i = 0; i < 500; i++) {
		if (check()) return;
		await tick();
	}
	throw new Error(`not reached: ${what}`);
}

/** A supervisor with fakes; `server` is what /api/health says. */
function harness(
	o: {
		mode?: AutoUpdateMode;
		server?: string | null;
		staged?: string;
		onSignal?: (w: FakeWorker, s: NodeJS.Signals) => void;
	} = {},
) {
	const workers: FakeWorker[] = [];
	const calls: string[] = [];
	const logs: string[] = [];
	const sleeps: number[] = [];
	let alive = 0;
	let maxAlive = 0;
	let server = o.server === undefined ? NEW : o.server;
	let clock = Date.parse("2026-11-13T10:00:00.000Z");
	const stop = new AbortController();
	/** Resolves the update-check sleep: the next check runs. */
	let wakeCheck: () => void = () => {};
	const opts: SupervisorOptions = {
		version: OLD,
		mode: o.mode ?? { kind: "on" },
		spawn: (state) => {
			alive++;
			maxAlive = Math.max(maxAlive, alive);
			const w = new FakeWorker(
				state,
				o.onSignal ??
					((w, s) => {
						if (s === "SIGTERM") w.exit(0);
					}),
			);
			void w.exited.then(() => alive--);
			workers.push(w);
			return w;
		},
		serverVersion: async () => server,
		stage: async () => {
			calls.push("stage");
			return { version: o.staged ?? server ?? "" };
		},
		install: async () => {
			calls.push("install");
		},
		discard: async () => {
			calls.push("discard");
		},
		rollback: async () => {
			calls.push("rollback");
			return true;
		},
		log: (l) => logs.push(l),
		signal: stop.signal,
		now: () => clock,
		sleep: (ms, signal) => {
			if (ms === 5 * 60_000 && !signal.aborted && signal !== stop.signal) {
				// The update check waits: the test wakes it.
				return new Promise<void>((r) => {
					wakeCheck = r;
					signal.addEventListener("abort", () => r(), { once: true });
				});
			}
			sleeps.push(ms);
			clock += ms;
			return Promise.resolve();
		},
	};
	return {
		opts,
		workers,
		calls,
		logs,
		sleeps,
		stop,
		maxAlive: () => maxAlive,
		setServer: (v: string | null) => {
			server = v;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		check: () => wakeCheck(),
	};
}

describe("supervise: update", () => {
	test("a version bump while a task runs: the worker drains, then the new binary runs; one worker at a time", async () => {
		const h = harness();
		const done = supervise(h.opts);
		await until(
			() => h.workers[0]?.signals.includes("SIGUSR2") ?? false,
			"drain",
		);
		// The worker drains: still running (its task finishes first).
		expect(h.calls).toEqual(["stage"]);
		expect(h.workers).toHaveLength(1);
		// The task finished: the worker ends with 75.
		h.workers[0]?.exit(WORKER_EXIT.restart);
		await until(() => h.workers.length === 2, "new worker");
		expect(h.calls).toEqual(["stage", "install"]);
		expect(h.maxAlive()).toBe(1);
		const state = h.workers[1]?.state;
		expect(state?.version).toBe(NEW);
		expect(state?.lastUpdate).toMatchObject({ from: OLD, to: NEW });
		expect(autoUpdateLine(state as SupervisorState)).toBe(
			`auto-update on, last update 2f22252 -> ce20fc6 at ${state?.lastUpdate?.at}`,
		);
		// The new worker is at the server's version: no second update.
		h.check();
		await tick();
		expect(h.calls).toEqual(["stage", "install"]);
		h.stop.abort();
		expect(await done).toBe(0);
		expect(h.workers[1]?.signals).toEqual(["SIGTERM"]);
	});

	test("a new version that crashes 3 times within 10 min is rolled back and not tried again", async () => {
		const h = harness();
		const done = supervise(h.opts);
		await until(
			() => h.workers[0]?.signals.includes("SIGUSR2") ?? false,
			"drain",
		);
		h.workers[0]?.exit(WORKER_EXIT.restart);
		for (let i = 1; i <= 3; i++) {
			await until(() => h.workers.length === i + 1, `worker ${i}`);
			expect(h.workers[i]?.state.version).toBe(NEW);
			h.workers[i]?.exit(1);
		}
		await until(() => h.workers.length === 5, "rolled back worker");
		expect(h.calls).toEqual(["stage", "install", "rollback"]);
		const s = h.workers[4]?.state as SupervisorState;
		expect(s.version).toBe(OLD);
		expect(s.rolledBack).toMatchObject({ to: NEW, back: OLD });
		expect(h.logs).toContain(
			"error: update to ce20fc6 rolled back to 2f22252: the worker crashed 3 times within 10 min (last exit 1)",
		);
		expect(autoUpdateLine(s)).toContain(
			"update to ce20fc6 rolled back to 2f22252",
		);
		// The server still says NEW: not staged again.
		h.check();
		await tick();
		await tick();
		expect(h.calls).toEqual(["stage", "install", "rollback"]);
		h.stop.abort();
		await done;
	});

	test("auto-update off: no version check; pinned: only that version", async () => {
		const off = harness({ mode: { kind: "off", why: "--no-auto-update" } });
		const d1 = supervise(off.opts);
		await until(() => off.workers.length === 1, "worker");
		await tick();
		expect(off.calls).toEqual([]);
		expect(autoUpdateLine(off.workers[0]?.state as SupervisorState)).toBe(
			"auto-update off (--no-auto-update)",
		);
		off.stop.abort();
		await d1;

		const pin = harness({ mode: { kind: "pin", version: "abc1234" } });
		const d2 = supervise(pin.opts);
		await until(() => pin.workers.length === 1, "worker");
		await tick();
		expect(pin.calls).toEqual([]);
		pin.setServer("abc1234");
		pin.check();
		await until(
			() => pin.workers[0]?.signals.includes("SIGUSR2") ?? false,
			"drain to the pin",
		);
		expect(pin.calls).toEqual(["stage"]);
		pin.stop.abort();
		await d2;
		// Stopped while draining: the staged binary is dropped.
		expect(pin.calls).toEqual(["stage", "discard"]);
	});

	test("a failed download keeps the worker running", async () => {
		const h = harness();
		h.opts.stage = async () => {
			throw new Error("sha256 mismatch");
		};
		const done = supervise(h.opts);
		await until(
			() => h.logs.some((l) => l.includes("auto-update failed")),
			"failure line",
		);
		expect(h.logs).toContain(
			"error: auto-update failed: sha256 mismatch; the runner keeps running 2f22252",
		);
		expect(h.workers[0]?.signals).toEqual([]);
		h.stop.abort();
		await done;
	});
});

describe("supervise: crash and exit codes", () => {
	test("a crashing worker restarts after 1 s, 5 s, 30 s, then every 5 min", async () => {
		const h = harness({ mode: { kind: "off" } });
		const done = supervise(h.opts);
		for (let i = 0; i < 5; i++) {
			await until(() => h.workers.length === i + 1, `worker ${i}`);
			h.workers[i]?.exit(1);
		}
		await until(() => h.workers.length === 6, "worker 6");
		expect(h.sleeps).toEqual([...CRASH_BACKOFF_MS, 300_000]);
		expect(h.logs).toContain("error: worker exited 1; restart 1 in 1 s");
		expect(h.logs).toContain("error: worker exited 1; restart 4 in 300 s");
		expect(h.workers[5]?.state.restarts).toBe(5);
		// No update was made: a crash of the current version is not rolled back.
		expect(h.calls).toEqual([]);
		h.stop.abort();
		await done;
	});

	test("a worker that ran 10 min resets the back-off", async () => {
		const h = harness({ mode: { kind: "off" } });
		const done = supervise(h.opts);
		await until(() => h.workers.length === 1, "w1");
		h.workers[0]?.exit(1);
		await until(() => h.workers.length === 2, "w2");
		h.advance(11 * 60_000);
		h.workers[1]?.exit(1);
		await until(() => h.workers.length === 3, "w3");
		expect(h.sleeps).toEqual([1_000, 1_000]);
		h.stop.abort();
		await done;
	});

	for (const [code, what] of [
		[WORKER_EXIT.revoked, "revoked"],
		[WORKER_EXIT.superseded, "superseded"],
		[WORKER_EXIT.usage, "usage"],
		[WORKER_EXIT.ok, "ok"],
	] as const)
		test(`exit ${code} (${what}) is not restarted: the supervisor ends with it`, async () => {
			const h = harness({ mode: { kind: "off" } });
			const done = supervise(h.opts);
			await until(() => h.workers.length === 1, "worker");
			h.workers[0]?.exit(code);
			expect(await done).toBe(code);
			expect(h.workers).toHaveLength(1);
			expect(h.sleeps).toEqual([]);
		});

	test("stop: SIGTERM to the worker; the supervisor ends when it does", async () => {
		const h = harness({
			mode: { kind: "off" },
			onSignal: () => {},
		});
		const done = supervise(h.opts);
		await until(() => h.workers.length === 1, "worker");
		h.stop.abort();
		await tick();
		expect(h.workers[0]?.signals).toEqual(["SIGTERM"]);
		let ended = false;
		void done.then(() => {
			ended = true;
		});
		await tick();
		expect(ended).toBe(false);
		// It gives its work back, then ends.
		h.workers[0]?.exit(0);
		expect(await done).toBe(0);
	});
});

describe("drainWorker", () => {
	test("holds new work, waits for every running task (never stops one), then restarts", async () => {
		let running = 2;
		const calls: string[] = [];
		let clock = 0;
		const stop = new AbortController();
		const p = drainWorker({
			running: () => running,
			hold: () => calls.push("hold"),
			done: () => calls.push("done"),
			log: (l) => calls.push(l),
			signal: stop.signal,
			pollMs: 1,
			sayEveryMs: 10,
			now: () => (clock += 4),
		});
		await Bun.sleep(20);
		expect(calls[0]).toBe("hold");
		expect(calls).not.toContain("done");
		expect(calls).toContain(
			"auto-update: still waiting for 2 running task(s); none is stopped",
		);
		running = 0;
		expect(await p).toBe(true);
		expect(calls.at(-1)).toBe("done");
	});

	test("a stop while draining: no restart", async () => {
		const stop = new AbortController();
		const calls: string[] = [];
		const p = drainWorker({
			running: () => 1,
			hold: () => {},
			done: () => calls.push("done"),
			log: () => {},
			signal: stop.signal,
			pollMs: 1,
		});
		stop.abort();
		expect(await p).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("modes and arguments", () => {
	const s = defaultSettings("r1");
	const exe = "/home/u/.local/bin/mastermind-runner";
	test("on by default; off by setting, from source or under bun; pinned", () => {
		expect(autoUpdateMode(s, OLD, exe, "https://mm")).toEqual({ kind: "on" });
		expect(
			autoUpdateMode({ ...s, autoUpdate: false }, OLD, exe, "https://mm"),
		).toEqual({ kind: "off", why: "--no-auto-update" });
		expect(autoUpdateMode(s, "dev", exe, "https://mm")).toEqual({
			kind: "off",
			why: "this runner runs from source (version dev)",
		});
		expect(autoUpdateMode(s, OLD, "/usr/bin/bun", "https://mm").kind).toBe(
			"off",
		);
		expect(
			autoUpdateMode({ ...s, pin: "abc" }, OLD, exe, "https://mm"),
		).toEqual({ kind: "pin", version: "abc" });
	});

	test("onboard --start runs the worker as start, without the token", () => {
		expect(
			workerArgv(
				["onboard", "mmt_tok", "--url", "https://mm", "--start"],
				"onboard",
				"mmt_tok",
			),
		).toEqual(["start", "--url", "https://mm"]);
	});
});

describe("real processes: a swap on disk and a rollback", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
		dir = "";
	});

	/** A worker binary: says its version, ends 75 on SIGUSR2, 0 on SIGTERM. */
	const worker = (v: string, crash = false) =>
		`#!/bin/sh
if [ "$1" = "--version" ]; then echo ${v}; exit 0; fi
echo "${v} $$" >> "$LOG"
${crash ? "exit 1" : ""}
trap 'exit 75' USR2
trap 'exit 0' TERM
while :; do sleep 0.05; done
`;
	const hex = (s: string) =>
		new Bun.CryptoHasher("sha256").update(s).digest("hex");

	test("the supervisor downloads, drains, swaps, and rolls a crashing version back", async () => {
		dir = await mkdtemp(join(tmpdir(), "mm-super-"));
		const exe = join(dir, "mastermind-runner");
		const log = join(dir, "log");
		await Bun.write(exe, worker(OLD));
		await chmod(exe, 0o755);
		await Bun.write(log, "");
		const binary = worker(NEW, true);
		const fetchFn = (async (input: string | URL | Request) => {
			const u = new URL(String(input));
			if (u.pathname.endsWith(".sha256"))
				return new Response(`${hex(binary)}  mastermind-runner\n`);
			return new Response(binary);
		}) as typeof fetch;
		const staged = join(dir, ".mastermind-runner.next");
		const stop = new AbortController();
		const logs: string[] = [];
		let server: string | null = OLD;
		let wake = () => {};
		const done = supervise({
			version: OLD,
			mode: { kind: "on" },
			signal: stop.signal,
			log: (l) => logs.push(l),
			spawn: () => {
				const p = Bun.spawn([exe], {
					env: { ...process.env, LOG: log },
					stdout: "ignore",
					stderr: "ignore",
				});
				return {
					pid: p.pid,
					exited: p.exited,
					kill: (s) => p.kill(s),
				};
			},
			serverVersion: async () => server,
			stage: () =>
				stageUpdate({
					url: "https://mm",
					exe,
					path: staged,
					fetch: fetchFn,
					platform: "linux",
					arch: "x64",
				}),
			install: () => installStaged({ version: "", path: staged }, exe, true),
			discard: () => rm(staged, { force: true }),
			rollback: () => rollbackInstall(exe),
			// Real waits, made short; the update check waits for `wake`.
			sleep: (ms, signal) =>
				ms === 5 * 60_000
					? new Promise<void>((r) => {
							wake = r;
							signal.addEventListener("abort", () => r(), { once: true });
						})
					: Bun.sleep(5),
		});
		const lines = async () =>
			(await Bun.file(log).text()).split("\n").filter(Boolean);
		const waitFor = async (n: number) => {
			for (let i = 0; i < 400 && (await lines()).length < n; i++)
				await Bun.sleep(25);
		};
		await waitFor(1);
		server = NEW;
		wake();
		// OLD drains (75), NEW starts and crashes 3 times, OLD comes back.
		await waitFor(5);
		const seen = (await lines()).map((l) => l.split(" ")[0]);
		expect(seen.slice(0, 5)).toEqual([OLD, NEW, NEW, NEW, OLD]);
		expect(await Bun.file(exe).text()).toBe(worker(OLD));
		expect(logs).toContain(
			"error: update to ce20fc6 rolled back to 2f22252: the worker crashed 3 times within 10 min (last exit 1)",
		);
		stop.abort();
		expect(await done).toBe(0);
		// Only the executable is left: no staged or kept file.
		expect((await readdir(dir)).sort()).toEqual(["log", "mastermind-runner"]);
		expect(previousPath(exe)).toBe(join(dir, ".mastermind-runner.previous"));
	}, 30_000);
});
