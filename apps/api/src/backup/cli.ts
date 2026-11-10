#!/usr/bin/env bun
// JetStream backup and restore by hand. It uses the api's env, so it runs in the app container
// (`bun backup.js ...` in the image) or from a clone (`bun apps/api/src/backup/cli.ts ...`).
//
//   list                       complete backups at BACKUP_URL, oldest first
//   backup                     back up every stream now (and prune to BACKUP_KEEP)
//   restore <id|latest> [--force] [--only <stream,...>]
//                              restore into this NATS. Without --force, a stream that exists
//                              must be empty. Restart the api afterwards.
//   usage                      JetStream storage use of the account
//   marker write|check|remove  a probe: one KV key and one stream message, to show that data
//                              survives a NATS redeploy. Remove it when done.
//
// Connection (the first that is set):
//   NATS_WS_URL + NATS_ISSUER_SEED   as the api: the internal APP token derived from the seed.
//                                    The api must run (its auth callout admits the token).
//   NATS_WS_URL + NATS_TOKEN | NATS_USER/NATS_PASSWORD | nothing (a local server without auth)
// Options: --url <BACKUP_URL> overrides the env. Secrets come from env only, never argv.
import { Store } from "@mastermind/bus";
import { type NatsConnection, wsconnect } from "@nats-io/nats-core";
import { internalTokens } from "../auth/callout.ts";
import { listBackups, restoreBackup } from "./backup.ts";
import { deleteStream, streamInfo } from "./jetstream.ts";
import { backupsFromEnv, safeUrl, storageStatus } from "./start.ts";
import { openTarget } from "./target.ts";

const env = process.env;
const args = process.argv.slice(2);

function flag(name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const value = args[i + 1];
	args.splice(i, 2);
	return value;
}
function bool(name: string): boolean {
	const i = args.indexOf(name);
	if (i >= 0) args.splice(i, 1);
	return i >= 0;
}

const MARKER_BUCKET = "mm_probe_marker";
const MARKER_STREAM = "MM_PROBE_MARKER";

async function connectNats(): Promise<NatsConnection> {
	const servers = env.NATS_WS_URL;
	if (!servers) throw new Error("set NATS_WS_URL (ws:// or wss://)");
	const auth = env.NATS_ISSUER_SEED
		? { token: internalTokens(env.NATS_ISSUER_SEED).app }
		: env.NATS_TOKEN
			? { token: env.NATS_TOKEN }
			: env.NATS_USER
				? { user: env.NATS_USER, pass: env.NATS_PASSWORD }
				: {};
	return wsconnect({ servers, name: "mastermind-backup-cli", ...auth });
}

function backupUrl(): string {
	const url = flag("--url") ?? env.BACKUP_URL;
	if (!url) throw new Error("set BACKUP_URL or pass --url");
	return url;
}

async function marker(nc: NatsConnection, op: string | undefined) {
	if (op === "write") {
		const at = new Date().toISOString();
		const kv = await Store.open<{ at: string }>(nc, MARKER_BUCKET);
		await kv.put("marker", { at });
		const created = await nc.request(
			`$JS.API.STREAM.CREATE.${MARKER_STREAM}`,
			JSON.stringify({
				name: MARKER_STREAM,
				subjects: ["mm.probe.marker"],
				storage: "file",
			}),
		);
		const err = created.json<{ error?: { err_code?: number } }>().error;
		// 10058: exists with the same name (a second write)
		if (err && err.err_code !== 10058) throw new Error(JSON.stringify(err));
		await nc.request("mm.probe.marker", JSON.stringify({ at }));
		console.log(
			`marker: written at ${at} (KV ${MARKER_BUCKET}/marker, stream ${MARKER_STREAM})`,
		);
		return;
	}
	if (op === "check") {
		const kv = await streamInfo(nc, `KV_${MARKER_BUCKET}`);
		const st = await streamInfo(nc, MARKER_STREAM);
		const value = kv
			? (
					await (
						await Store.open<{ at: string }>(nc, MARKER_BUCKET)
					).get("marker")
				)?.value
			: null;
		console.log(
			`marker: KV ${value ? `at ${value.at}` : "MISSING"}; stream ${st ? `${st.state.messages} messages` : "MISSING"}`,
		);
		if (!value || !st?.state.messages) process.exitCode = 1;
		return;
	}
	if (op === "remove") {
		for (const name of [`KV_${MARKER_BUCKET}`, MARKER_STREAM])
			if (await streamInfo(nc, name)) await deleteStream(nc, name);
		console.log("marker: removed");
		return;
	}
	throw new Error("usage: marker write|check|remove");
}

async function main() {
	const command = args.shift();
	if (command === "list") {
		const url = backupUrl();
		const ids = await listBackups(openTarget(url));
		console.log(`${ids.length} backups at ${safeUrl(url)}`);
		for (const id of ids) console.log(`  ${id}`);
		return;
	}
	const nc = await connectNats();
	try {
		if (command === "backup") {
			const backups = backupsFromEnv(
				{ ...env, BACKUP_URL: backupUrl(), BACKUP_FIRST_DELAY_MS: "3600000" },
				Promise.resolve(nc),
			);
			await backups?.run();
			backups?.stop();
			if (backups?.status().error) process.exitCode = 1;
		} else if (command === "restore") {
			const force = bool("--force");
			const only = flag("--only")?.split(",");
			const url = backupUrl();
			const target = openTarget(url);
			let id = args.shift();
			if (id === "latest") id = (await listBackups(target)).at(-1);
			if (!id)
				throw new Error("usage: restore <id|latest> [--force] [--only a,b]");
			const r = await restoreBackup(nc, target, id, { force, only });
			for (const s of r.restored)
				console.log(
					`restored ${s.name}: ${s.messages} messages${r.replaced.includes(s.name) ? " (replaced)" : ""}`,
				);
			console.log(
				`restore: ${id} from ${safeUrl(url)} done. Restart the api now.`,
			);
		} else if (command === "usage") {
			console.log(JSON.stringify(await storageStatus(nc)));
		} else if (command === "marker") {
			await marker(nc, args.shift());
		} else {
			throw new Error(
				"usage: list | backup | restore <id|latest> [--force] [--only a,b] | usage | marker write|check|remove",
			);
		}
	} finally {
		await nc.close();
	}
}

await main().catch((error) => {
	console.error(`backup: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
