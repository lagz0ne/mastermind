import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../src/cli.ts";
import { defaultSettings, saveConfig } from "../src/config.ts";
import {
	acquireLock,
	LockedError,
	lockPath,
	readLock,
	runningOther,
	stopRunner,
} from "../src/lock.ts";

const dir = mkdtempSync(join(tmpdir(), "mm-runner-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const fresh = () => join(dir, `l${n++}`, "runner.pid");
const info = (pid: number) => ({
	pid,
	runner: "yo-buid",
	session: "s-1",
	startedAt: "2026-11-12T09:00:00.000Z",
	version: "1948c46",
});

/** A live process that is not this one (ends on SIGTERM). */
function other() {
	return Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
}

describe("one runner process per config (mm-210.79)", () => {
	test("take, refuse a second live process, release", async () => {
		const path = fresh();
		const lock = await acquireLock(path, info(process.pid));
		expect((await readLock(path))?.pid).toBe(process.pid);
		// Another live process holds it: refused with its PID.
		const p = other();
		try {
			await expect(acquireLock(path, info(p.pid))).rejects.toThrow(
				`runner yo-buid already runs here (PID ${process.pid}`,
			);
			expect(await runningOther(path, p.pid)).toMatchObject({
				pid: process.pid,
			});
		} finally {
			p.kill();
		}
		await lock.release();
		expect(existsSync(path)).toBe(false);
	});

	test("a stale pid file (dead process) is replaced; the same PID (exec restart) too", async () => {
		const path = fresh();
		await Bun.write(path, JSON.stringify(info(999_999_999)));
		const lock = await acquireLock(path, info(process.pid));
		expect((await readLock(path))?.pid).toBe(process.pid);
		// An --auto-update restart: same PID, the file is still there.
		const again = await acquireLock(path, info(process.pid));
		expect((await readLock(path))?.pid).toBe(process.pid);
		await again.release();
		await lock.release();
	});

	test("release leaves a pid file of another process alone", async () => {
		const path = fresh();
		const lock = await acquireLock(path, info(process.pid));
		writeFileSync(path, JSON.stringify(info(4242)));
		await lock.release();
		expect((await readLock(path))?.pid).toBe(4242);
	});

	test("LockedError names the PID", () => {
		expect(new LockedError(info(77)).message).toBe(
			"runner yo-buid already runs here (PID 77, started 2026-11-12T09:00:00.000Z, version 1948c46); stop it first: mastermind-runner stop",
		);
	});

	test("stop sends SIGTERM to that PID only and waits", async () => {
		const path = fresh();
		const p = other();
		await Bun.write(path, JSON.stringify(info(p.pid)));
		const r = await stopRunner(path, { waitMs: 5_000 });
		expect(r.kind).toBe("stopped");
		expect(await p.exited).not.toBe(0);
		expect((await stopRunner(path)).kind).toBe("not-running");
	});
});

describe("cli: start and stop", () => {
	function io(cfg: string) {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: {
				env: { MASTERMIND_RUNNER_CONFIG: cfg },
				out: (l: string) => out.push(l),
				err: (l: string) => err.push(l),
				cwd: dir,
			},
		};
	}

	test("a second start on the same config exits 2 with the PID line; stop ends the first", async () => {
		const cfg = join(dir, "cli", "runner.json");
		await saveConfig(cfg, {
			version: 1,
			mastermindUrl: "http://127.0.0.1:1",
			natsUrl: "ws://127.0.0.1:1",
			account: "alice",
			serviceAccount: { id: "0a1b2c", name: "laptop" },
			credential: "mms_alice_0a1b2c_secret",
			inboxPrefix: "_INBOX.alice",
			state: "active",
			enrolledAt: "2026-11-12T09:00:00.000Z",
			runner: { ...defaultSettings("yo-buid"), queues: ["build"] },
		});
		const first = other();
		await Bun.write(lockPath(cfg), JSON.stringify(info(first.pid)));
		const t = io(cfg);
		expect(await main(["start", "--no-box"], t.io)).toBe(EXIT.usage);
		expect(t.err).toEqual([
			`runner yo-buid already runs here (PID ${first.pid}, started 2026-11-12T09:00:00.000Z, version 1948c46); stop it first: mastermind-runner stop`,
		]);
		// The refused start did not touch the first one's pid file.
		expect((await readLock(lockPath(cfg)))?.pid).toBe(first.pid);
		const s = io(cfg);
		expect(await main(["stop"], s.io)).toBe(EXIT.ok);
		expect(s.out).toEqual([`runner yo-buid (PID ${first.pid}) stopped`]);
		await first.exited;
		const again = io(cfg);
		expect(await main(["stop"], again.io)).toBe(EXIT.ok);
		expect(again.out).toEqual(["no runner runs with this config"]);
	});
});
