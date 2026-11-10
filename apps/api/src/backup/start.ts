// The api backs up JetStream on a timer. Why the api and not a job in deploy/: account APP is
// reachable only through the api's auth callout, and the api already holds that connection.
// A separate job would need its own credential and its own schedule runner.
//
// Env (see docs/deploy.md):
//   BACKUP_URL                    file:///<dir> or s3://<bucket>/<prefix>. Unset: no backups.
//   BACKUP_INTERVAL_MINUTES       default 360. One backup also runs BACKUP_FIRST_DELAY_MS after start.
//   BACKUP_KEEP                   complete backups to keep, default 28 (7 days at 6h).
import type { NatsConnection } from "@nats-io/nats-core";
import { backupAll } from "./backup.ts";
import { type AccountUsage, accountUsage } from "./jetstream.ts";
import { openTarget } from "./target.ts";

/** Health warns when JetStream storage use is above this fraction of the account limit. */
export const STORAGE_WARN = 0.8;

export type StorageStatus = {
	used: number;
	limit: number | null;
	/** Percent of the limit, rounded; null without a limit. */
	percent: number | null;
	warn: boolean;
};

export type BackupStatus = {
	url: string;
	last: { id: string; streams: number; bytes: number; ms: number } | null;
	error: string | null;
};

export async function storageStatus(
	nc: NatsConnection,
): Promise<StorageStatus> {
	return toStorageStatus(await accountUsage(nc));
}

export function toStorageStatus(u: AccountUsage): StorageStatus {
	const ratio = u.maxStorage ? u.storage / u.maxStorage : null;
	return {
		used: u.storage,
		limit: u.maxStorage,
		percent: ratio === null ? null : Math.round(ratio * 100),
		warn: ratio !== null && ratio > STORAGE_WARN,
	};
}

/** A string URL without user info, for logs and health. */
export function safeUrl(url: string): string {
	const u = new URL(url);
	u.username = "";
	u.password = "";
	return u.href;
}

export type Backups = {
	status(): BackupStatus;
	run(): Promise<void>;
	stop(): void;
};

export function startBackups(opts: {
	connection: Promise<NatsConnection>;
	url: string;
	intervalMinutes?: number;
	keep?: number;
	firstDelayMs?: number;
	log?: (line: string) => void;
}): Backups {
	const target = openTarget(opts.url);
	const log = opts.log ?? ((line) => console.log(line));
	const state: BackupStatus = {
		url: safeUrl(opts.url),
		last: null,
		error: null,
	};
	let running: Promise<void> | null = null;
	const run = () => {
		running ??= (async () => {
			const started = performance.now();
			try {
				const nc = await opts.connection;
				const { id, manifest, pruned } = await backupAll(nc, target, {
					keep: opts.keep ?? 28,
				});
				const bytes = manifest.streams.reduce((n, s) => n + s.bytes, 0);
				const ms = Math.round(performance.now() - started);
				state.last = { id, streams: manifest.streams.length, bytes, ms };
				state.error = null;
				log(
					`backup: ${id}: ${manifest.streams.length} streams, ${bytes} bytes to ${state.url} in ${ms}ms${pruned.length ? `; pruned ${pruned.join(", ")}` : ""}`,
				);
			} catch (error) {
				state.error = String(error);
				log(`backup: failed: ${error}`);
			} finally {
				running = null;
			}
		})();
		return running;
	};
	const first = setTimeout(run, opts.firstDelayMs ?? 60_000);
	const timer = setInterval(run, (opts.intervalMinutes ?? 360) * 60_000);
	return {
		status: () => ({ ...state }),
		run,
		stop() {
			clearTimeout(first);
			clearInterval(timer);
		},
	};
}

/** Backups from env; null when BACKUP_URL is unset. */
export function backupsFromEnv(
	env: Record<string, string | undefined>,
	connection: Promise<NatsConnection>,
): Backups | null {
	if (!env.BACKUP_URL) return null;
	const num = (v: string | undefined) =>
		v && Number.isFinite(Number(v)) ? Number(v) : undefined;
	return startBackups({
		connection,
		url: env.BACKUP_URL,
		intervalMinutes: num(env.BACKUP_INTERVAL_MINUTES),
		keep: num(env.BACKUP_KEEP),
		firstDelayMs: num(env.BACKUP_FIRST_DELAY_MS),
	});
}
