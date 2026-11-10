// Backup of every JetStream stream (work items, events, and every KV bucket: accounts, routing,
// environments, ...) of one account, and restore of such a backup.
//
// Layout on the target, one directory per backup, named by its UTC time (sorts by age):
//   <id>/<stream>.snap      the server's snapshot of the stream (s2 tar), with durable consumers
//   <id>/manifest.json      written LAST: a backup without it is incomplete and never restored
import type { NatsConnection } from "@nats-io/nats-core";
import {
	deleteStream,
	restoreStream,
	type StreamInfo,
	snapshotStream,
	streamInfo,
	streamNames,
} from "./jetstream.ts";
import type { Target } from "./target.ts";

export const FORMAT = "mastermind-jetstream-backup/1";

export type ManifestStream = StreamInfo & {
	file: string;
	bytes: number;
	sha256: string;
};
export type Manifest = {
	format: string;
	at: string;
	streams: ManifestStream[];
};

/** 2026-11-10T12:00:00.123Z → 2026-11-10T12-00-00-123Z: sorts by time, no colon, unique per ms */
export const backupId = (at: Date) =>
	at.toISOString().replaceAll(":", "-").replace(".", "-");

/** Snapshot every stream to `<id>/`, then write the manifest, then prune to `keep` backups. */
export async function backupAll(
	nc: NatsConnection,
	target: Target,
	opts: { keep?: number; now?: Date } = {},
): Promise<{ id: string; manifest: Manifest; pruned: string[] }> {
	const at = opts.now ?? new Date();
	const id = backupId(at);
	const streams: ManifestStream[] = [];
	for (const name of await streamNames(nc)) {
		const file = `${name}.snap`;
		const sink = await target.writer(`${id}/${file}`);
		const hash = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		let info: StreamInfo;
		try {
			info = await snapshotStream(nc, name, async (chunk) => {
				hash.update(chunk);
				bytes += chunk.length;
				await sink.write(chunk);
			});
		} finally {
			await sink.end();
		}
		streams.push({ ...info, file, bytes, sha256: hash.digest("hex") });
	}
	const manifest: Manifest = { format: FORMAT, at: at.toISOString(), streams };
	await target.write(
		`${id}/manifest.json`,
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	const pruned = opts.keep ? await prune(target, opts.keep) : [];
	return { id, manifest, pruned };
}

/** Complete backups (with a manifest), oldest first. */
export async function listBackups(target: Target): Promise<string[]> {
	const ids: string[] = [];
	for (const id of await target.list(""))
		if ((await target.text(`${id}/manifest.json`)) !== null) ids.push(id);
	return ids;
}

export async function readManifest(
	target: Target,
	id: string,
): Promise<Manifest> {
	const text = await target.text(`${id}/manifest.json`);
	if (text === null)
		throw new Error(`no complete backup ${id} in ${target.url}`);
	const manifest = JSON.parse(text) as Manifest;
	if (manifest.format !== FORMAT)
		throw new Error(`backup ${id}: unknown format ${manifest.format}`);
	return manifest;
}

/**
 * Keep the newest `keep` complete backups. Also remove incomplete ones that are older than the
 * newest complete backup (a run that died); a newer incomplete one may still be running.
 */
export async function prune(target: Target, keep: number): Promise<string[]> {
	const all = await target.list("");
	const complete = await listBackups(target);
	const newest = complete.at(-1);
	const drop = new Set(complete.slice(0, Math.max(0, complete.length - keep)));
	for (const id of all)
		if (!complete.includes(id) && newest !== undefined && id < newest)
			drop.add(id);
	for (const id of drop) await target.remove(id);
	return [...drop].sort();
}

export type RestoreResult = {
	id: string;
	restored: { name: string; messages: number }[];
	replaced: string[];
};

/**
 * Restore backup `id` into the account of `nc`. Every file is checked against its sha256
 * before anything changes. A stream that exists is replaced only when it is empty (the api
 * makes empty buckets when it starts), or with `force`. Restart the api afterwards: it holds
 * the old state in memory.
 */
export async function restoreBackup(
	nc: NatsConnection,
	target: Target,
	id: string,
	opts: { force?: boolean; only?: string[] } = {},
): Promise<RestoreResult> {
	const manifest = await readManifest(target, id);
	const streams = opts.only
		? manifest.streams.filter((s) => opts.only?.includes(s.config.name))
		: manifest.streams;

	for (const s of streams) {
		const hash = new Bun.CryptoHasher("sha256");
		for await (const chunk of await target.read(`${id}/${s.file}`))
			hash.update(chunk);
		if (hash.digest("hex") !== s.sha256)
			throw new Error(`backup ${id}: ${s.file} does not match its sha256`);
	}
	const replace: string[] = [];
	for (const s of streams) {
		const live = await streamInfo(nc, s.config.name);
		if (!live) continue;
		if (live.state.messages > 0 && !opts.force)
			throw new Error(
				`stream ${s.config.name} exists with ${live.state.messages} messages; restore into an empty NATS, or pass --force to replace it`,
			);
		replace.push(s.config.name);
	}
	for (const name of replace) await deleteStream(nc, name);

	const restored: RestoreResult["restored"] = [];
	for (const s of streams) {
		const info = await restoreStream(
			nc,
			s,
			await target.read(`${id}/${s.file}`),
		);
		restored.push({ name: info.config.name, messages: info.state.messages });
	}
	return { id, restored, replaced: replace };
}
