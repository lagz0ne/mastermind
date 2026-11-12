/**
 * One runner process per config (mm-210.79). `start` writes a pid file next to
 * runner.json (`runner.pid`, created with O_EXCL); a second `start` on the
 * same config finds the live PID and refuses. A pid file whose process is gone
 * (a crash, a reboot) is stale: it is replaced. The same PID is this process
 * itself (an --auto-update restart execs in place).
 *
 * Prior art: the PostgreSQL postmaster.pid and most Unix daemons (a pid file
 * plus kill(pid, 0) for liveness). An flock would also free itself on a
 * crash, but Bun has no flock without FFI; kill(pid, 0) covers the crash.
 * `stop` ends the runner by that PID (SIGTERM, then waits), never by name.
 */
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What the pid file holds. */
export type LockInfo = {
	pid: number;
	/** The runner id that runs (the config's). */
	runner: string;
	/** The process's session (mm-210.79). */
	session?: string;
	startedAt: string;
	version?: string;
};

export function lockPath(configPath: string): string {
	return join(dirname(configPath), "runner.pid");
}

/** Is a process with this PID alive (EPERM: alive, owned by another user)? */
export function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid file, or null (none, unreadable, not ours). */
export async function readLock(path: string): Promise<LockInfo | null> {
	try {
		const v = JSON.parse(await readFile(path, "utf8")) as Partial<LockInfo>;
		if (typeof v?.pid !== "number") return null;
		return {
			pid: v.pid,
			runner: typeof v.runner === "string" ? v.runner : "?",
			startedAt: typeof v.startedAt === "string" ? v.startedAt : "?",
			...(typeof v.session === "string" ? { session: v.session } : {}),
			...(typeof v.version === "string" ? { version: v.version } : {}),
		};
	} catch {
		return null;
	}
}

/** The runner process of this config that is alive and is not `self`, or null. */
export async function runningOther(
	path: string,
	self: number = process.pid,
	isAlive: (pid: number) => boolean = alive,
): Promise<LockInfo | null> {
	const l = await readLock(path);
	return l && l.pid !== self && isAlive(l.pid) ? l : null;
}

export class LockedError extends Error {
	override name = "LockedError";
	constructor(readonly holder: LockInfo) {
		super(
			`runner ${holder.runner} already runs here (PID ${holder.pid}, started ${holder.startedAt}${holder.version ? `, version ${holder.version}` : ""}); stop it first: mastermind-runner stop`,
		);
	}
}

export type Lock = {
	/** Remove the pid file if it is still this process's. */
	release(): Promise<void>;
};

/**
 * Take the pid file for this process; LockedError when another live process
 * holds it. `info.pid` is this process.
 */
export async function acquireLock(
	path: string,
	info: LockInfo,
	isAlive: (pid: number) => boolean = alive,
): Promise<Lock> {
	const body = `${JSON.stringify(info)}\n`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fh = await open(path, "wx", 0o600);
			try {
				await fh.writeFile(body);
			} finally {
				await fh.close();
			}
			return lockOf(path, info.pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = await readLock(path);
		if (held && held.pid !== info.pid && isAlive(held.pid))
			throw new LockedError(held);
		// Stale (dead PID, unreadable) or this very process (exec restart).
		await rm(path, { force: true });
	}
	throw new Error(`cannot take ${path}: it keeps coming back`);
}

function lockOf(path: string, pid: number): Lock {
	return {
		async release() {
			const l = await readLock(path);
			if (l?.pid === pid) await rm(path, { force: true });
		},
	};
}

export type StopResult =
	| { kind: "not-running" }
	| { kind: "stopped"; holder: LockInfo }
	| { kind: "still-running"; holder: LockInfo };

/**
 * Stop the runner of this config by its PID: SIGTERM (it gives its work
 * back), then wait up to `waitMs` for it to end.
 */
export async function stopRunner(
	path: string,
	o: {
		waitMs?: number;
		isAlive?: (pid: number) => boolean;
		kill?: (pid: number, signal: NodeJS.Signals) => void;
		self?: number;
	} = {},
): Promise<StopResult> {
	const isAlive = o.isAlive ?? alive;
	const holder = await runningOther(path, o.self ?? process.pid, isAlive);
	if (!holder) return { kind: "not-running" };
	(o.kill ?? ((pid, sig) => process.kill(pid, sig)))(holder.pid, "SIGTERM");
	const end = Date.now() + (o.waitMs ?? 60_000);
	while (Date.now() < end) {
		if (!isAlive(holder.pid)) return { kind: "stopped", holder };
		await Bun.sleep(200);
	}
	return isAlive(holder.pid)
		? { kind: "still-running", holder }
		: { kind: "stopped", holder };
}
