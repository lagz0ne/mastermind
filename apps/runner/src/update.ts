/**
 * Runner updates (mm-210.77). Prior art: `bun upgrade`, `rustup self update`
 * (a self-update command) and the GitHub Actions self-hosted runner (it stops
 * taking jobs, finishes the running one, updates and restarts itself).
 *
 *   mastermind-runner update            download the server's runner, check its
 *                                       sha256, replace this executable
 *   mastermind-runner update --check    only report
 *   mastermind-runner start --auto-update
 *                                       when the server is at another version:
 *                                       take no new work, wait until nothing
 *                                       runs, update, restart (off by default)
 *
 * The binary comes from the same place as install.sh:
 * `<url>/download/mastermind-runner?os=&arch=`, checked against
 * `<url>/download/mastermind-runner.sha256?os=&arch=`. The new file is written
 * next to the executable, started once with `--version`, then renamed over it
 * (atomic: a crash leaves the old or the new binary, never half of one).
 */
import { chmod, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runnerVersionNotice, shortVersion } from "@mastermind/core";

export class UpdateError extends Error {
	override name = "UpdateError";
}

/** os-arch of a runner build, as /download/mastermind-runner wants it. */
export function runnerTarget(
	platform: string = process.platform,
	arch: string = process.arch,
): { os: string; arch: string } {
	const os = platform === "linux" || platform === "darwin" ? platform : null;
	const a = arch === "x64" || arch === "arm64" ? arch : null;
	if (!os || !a)
		throw new UpdateError(
			`no runner build for ${platform}-${arch} (linux and darwin, x64 and arm64 only)`,
		);
	return { os, arch: a };
}

const trimUrl = (url: string) => url.replace(/\/+$/, "");

/** The version the server runs (GET /api/health); null: no answer. */
export async function serverVersion(
	url: string,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	try {
		const res = await fetchFn(`${trimUrl(url)}/api/health`, {
			signal: AbortSignal.timeout(10_000),
		});
		const v = ((await res.json()) as { version?: unknown }).version;
		return typeof v === "string" && v ? v : null;
	} catch {
		return null;
	}
}

export type UpdateOptions = {
	/** Mastermind origin. */
	url: string;
	/** This runner's version (cli.ts VERSION). */
	version: string;
	/** The executable to replace (default: process.execPath). */
	exe?: string;
	/** Only report. */
	check?: boolean;
	fetch?: typeof fetch;
	platform?: string;
	arch?: string;
	/** `<exe> --version` of the new binary (tests). */
	runVersion?: (exe: string) => Promise<string>;
};

export type UpdateResult =
	| { state: "current"; version: string; server: string }
	| { state: "available"; version: string; server: string; notice: string }
	| { state: "updated"; from: string; to: string; path: string };

/** One line for the terminal. */
export function updateLine(r: UpdateResult): string {
	if (r.state === "current")
		return `mastermind-runner ${shortVersion(r.version)} is the server's version`;
	if (r.state === "available") return r.notice;
	return `mastermind-runner updated: ${shortVersion(r.from)} -> ${shortVersion(r.to)} (${r.path}); restart the runner to use it`;
}

async function fileSha256(path: string): Promise<string> {
	const h = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) h.update(chunk);
	return h.digest("hex");
}

async function defaultRunVersion(exe: string): Promise<string> {
	const p = Bun.spawn([exe, "--version"], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [out, code] = await Promise.all([
		new Response(p.stdout).text(),
		p.exited,
	]);
	if (code !== 0) throw new Error(`exit ${code}`);
	return out.trim();
}

/**
 * Compare with the server; unless `check`, download the server's runner,
 * check its sha256 and that it starts, and replace `exe` with it.
 */
export async function selfUpdate(o: UpdateOptions): Promise<UpdateResult> {
	const url = trimUrl(o.url);
	const fetchFn = o.fetch ?? fetch;
	const server = await serverVersion(url, fetchFn);
	if (!server)
		throw new UpdateError(
			`cannot read the server version at ${url}/api/health; check the network and MASTERMIND_URL`,
		);
	if (o.version === server)
		return { state: "current", version: o.version, server };
	if (o.version === "dev")
		throw new UpdateError(
			"this runner runs from source (version dev): update the checkout instead",
		);
	const notice =
		runnerVersionNotice(o.version, server) ??
		`the server is at ${shortVersion(server)}`;
	if (o.check)
		return { state: "available", version: o.version, server, notice };

	const exe = o.exe ?? process.execPath;
	if (basename(exe) === "bun")
		throw new UpdateError(
			`this runner runs under bun (${exe}), not as the installed executable: curl -fsSL ${url}/install.sh | sh`,
		);
	const t = runnerTarget(o.platform, o.arch);
	const query = `os=${t.os}&arch=${t.arch}`;
	const sumRes = await fetchFn(
		`${url}/download/mastermind-runner.sha256?${query}`,
	).catch(() => null);
	if (!sumRes?.ok)
		throw new UpdateError(`no sha256 for ${t.os}-${t.arch} at ${url}`);
	const expected = (await sumRes.text()).trim().split(/\s+/)[0] ?? "";
	if (!/^[0-9a-f]{64}$/i.test(expected))
		throw new UpdateError(`the sha256 from ${url} is not a sha256`);

	const tmp = join(dirname(exe), `.${basename(exe)}.update-${process.pid}`);
	try {
		const bin = await fetchFn(`${url}/download/mastermind-runner?${query}`);
		if (!bin.ok || !bin.body)
			throw new UpdateError(`download failed: HTTP ${bin.status}`);
		try {
			await Bun.write(tmp, bin);
		} catch (error) {
			throw new UpdateError(
				`cannot write next to ${exe} (${error instanceof Error ? error.message : error}); run the update as the owner of ${dirname(exe)}, or: curl -fsSL ${url}/install.sh | sh`,
			);
		}
		const actual = await fileSha256(tmp);
		if (actual !== expected.toLowerCase())
			throw new UpdateError(
				`sha256 mismatch: expected ${expected}, got ${actual}; nothing replaced`,
			);
		await chmod(tmp, 0o755);
		let to: string;
		try {
			to = await (o.runVersion ?? defaultRunVersion)(tmp);
		} catch (error) {
			throw new UpdateError(
				`the new binary does not start (${error instanceof Error ? error.message : error}); nothing replaced`,
			);
		}
		await rename(tmp, exe);
		return { state: "updated", from: o.version, to, path: exe };
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

export type VersionWatchOptions = {
	/** This runner's version. */
	version: string;
	/** The server's version; null: no answer. */
	serverVersion: () => Promise<string | null>;
	/** Update and restart when idle (setting autoUpdate). */
	autoUpdate: boolean;
	/** Nothing in flight. */
	idle: () => boolean;
	/** Resolves when nothing is in flight (or `signal` aborts). */
	waitIdle: (signal?: AbortSignal) => Promise<void>;
	/** Download and replace (selfUpdate). */
	update: () => Promise<UpdateResult>;
	/** Stop and start the new binary. */
	restart: (to: string) => void;
	/** The notice changed (null: none); the caller shows it in status and readiness. */
	onNotice: (notice: string | null) => void;
	/** Auto-update in progress: take no new work while set (null: done or failed). */
	onDraining: (why: string | null) => void;
	log: (line: string) => void;
	signal?: AbortSignal;
};

/**
 * At start and every re-check: compare with the server, say it once per
 * server version, and with autoUpdate update when idle and restart.
 */
export function versionWatch(o: VersionWatchOptions) {
	let said: string | null = null;
	let busy = false;
	return {
		async tick(): Promise<void> {
			if (busy) return;
			const server = await o.serverVersion();
			if (!server) return;
			const notice = runnerVersionNotice(o.version, server);
			if (notice !== said) {
				o.onNotice(notice);
				if (notice) o.log(`warning: ${notice}`);
				said = notice;
			}
			if (!notice || !o.autoUpdate) return;
			busy = true;
			try {
				// Like the GitHub Actions runner: no new work, the running one finishes.
				o.onDraining(
					`updating to ${shortVersion(server)}: no new work until the running tasks finish`,
				);
				if (!o.idle()) {
					o.log(
						`auto-update to ${shortVersion(server)}: waiting until no task runs`,
					);
					await o.waitIdle(o.signal);
				}
				if (o.signal?.aborted) return;
				const r = await o.update();
				if (r.state !== "updated") {
					o.onDraining(null);
					return;
				}
				o.log(updateLine(r).replace("; restart the runner to use it", ""));
				o.log(`auto-update: restarting as ${shortVersion(r.to)}`);
				o.restart(r.to);
			} catch (error) {
				o.log(
					`error: auto-update failed: ${error instanceof Error ? error.message : error}; the runner keeps running ${shortVersion(o.version)}`,
				);
				o.onDraining(null);
			} finally {
				busy = false;
			}
		},
	};
}
