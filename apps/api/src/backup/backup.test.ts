// Backup and restore against real nats-servers. Needs NATS_SERVER=/path/to/nats-server
// (or nats-server on PATH); skips without one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "@mastermind/bus";
import { type NatsConnection, wsconnect } from "@nats-io/nats-core";
import { type NatsServer, startNats } from "../dispatch/nats-server.ts";
import {
	backupAll,
	backupId,
	listBackups,
	prune,
	readManifest,
	restoreBackup,
} from "./backup.ts";
import { accountUsage, streamInfo } from "./jetstream.ts";
import { startBackups, toStorageStatus } from "./start.ts";
import { openTarget, type Target } from "./target.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

function tempTarget(): { target: Target; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mm-backup-"));
	return { target: openTarget(pathToFileURL(dir).href), dir };
}

describe("file target and prune", () => {
	test("keeps the newest N complete backups and drops older incomplete ones", async () => {
		const { target, dir } = tempTarget();
		try {
			const ids = [
				"2026-01-01T00-00-00Z",
				"2026-01-02T00-00-00Z",
				"2026-01-03T00-00-00Z",
			];
			for (const id of ids) await target.write(`${id}/manifest.json`, "{}");
			await target.write("2026-01-01T12-00-00Z/X.snap", "partial"); // died: no manifest
			await target.write("2026-01-04T00-00-00Z/X.snap", "running"); // newer: may be running
			expect(await listBackups(target)).toEqual(ids);
			expect(await prune(target, 2)).toEqual([
				"2026-01-01T00-00-00Z",
				"2026-01-01T12-00-00Z",
			]);
			expect(await target.list("")).toEqual([
				"2026-01-02T00-00-00Z",
				"2026-01-03T00-00-00Z",
				"2026-01-04T00-00-00Z",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("backup ids sort by time and have no colon", () => {
		expect(backupId(new Date("2026-11-10T09:05:07.123Z"))).toBe(
			"2026-11-10T09-05-07Z",
		);
	});

	test("unknown BACKUP_URL scheme is an error", () => {
		expect(() => openTarget("http://x/y")).toThrow("BACKUP_URL");
	});
});

describe.skipIf(!bin)("JetStream backup and restore", () => {
	let source: NatsServer;
	let empty: NatsServer;
	let a: NatsConnection;
	let b: NatsConnection;
	const { target, dir } = tempTarget();

	beforeAll(async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		[source, empty] = await Promise.all([startNats(bin!), startNats(bin!)]);
		[a, b] = await Promise.all([
			wsconnect({ servers: source.url }),
			wsconnect({ servers: empty.url }),
		]);
	});

	afterAll(async () => {
		await Promise.all([a?.close(), b?.close()]);
		source?.stop();
		empty?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("a restore into an empty NATS gives the same KV values and stream messages", async () => {
		// KV buckets like the api's (accounts, routing) and a work-like stream.
		const accounts = await Store.open<{ name: string }>(a, "mm_accounts");
		await accounts.put("duke", { name: "duke" });
		await accounts.put("ana", { name: "ana" });
		await accounts.delete("ana");
		const config = await Store.open<{ queues: string[] }>(a, "mm_config");
		await config.put("routing", { queues: ["default", "ops"] });
		const created = await a.request(
			"$JS.API.STREAM.CREATE.MM_WORK",
			JSON.stringify({
				name: "MM_WORK",
				subjects: ["mm.work.>"],
				storage: "file",
				max_bytes: 1024 * 1024,
				discard: "new",
				allow_direct: true,
			}),
		);
		expect(created.json<{ error?: unknown }>().error).toBeUndefined();
		// Big enough for several snapshot chunks.
		const big = "x".repeat(200_000);
		for (let i = 1; i <= 3; i++)
			await a.request(`mm.work.mm-${i}`, JSON.stringify({ op: "create", big }));

		const { id, manifest } = await backupAll(a, target);
		expect(manifest.streams.map((s) => s.config.name)).toEqual([
			"KV_mm_accounts",
			"KV_mm_config",
			"MM_WORK",
		]);
		expect((await readManifest(target, id)).streams[2]?.state.messages).toBe(3);

		// The api makes empty buckets when it starts: those are replaced without --force.
		await Store.open(b, "mm_config");
		const result = await restoreBackup(b, target, id);
		expect(result.replaced).toEqual(["KV_mm_config"]);
		expect(result.restored).toEqual([
			{ name: "KV_mm_accounts", messages: 2 },
			{ name: "KV_mm_config", messages: 1 },
			{ name: "MM_WORK", messages: 3 },
		]);

		const restoredAccounts = await Store.open<{ name: string }>(
			b,
			"mm_accounts",
		);
		expect((await restoredAccounts.get("duke"))?.value).toEqual({
			name: "duke",
		});
		expect(await restoredAccounts.get("ana")).toBeNull();
		const restoredConfig = await Store.open<{ queues: string[] }>(
			b,
			"mm_config",
		);
		expect((await restoredConfig.get("routing"))?.value.queues).toEqual([
			"default",
			"ops",
		]);
		const work = await streamInfo(b, "MM_WORK");
		expect(work?.state.last_seq).toBe(3);
		expect(work?.config.max_bytes).toBe(1024 * 1024);
		expect(work?.config.discard).toBe("new");
		const last = await b.request(
			"$JS.API.DIRECT.GET.MM_WORK",
			JSON.stringify({ last_by_subj: "mm.work.mm-2" }),
		);
		expect(last.json<{ op: string }>().op).toBe("create");
		expect((await accountUsage(b)).streams).toBe(3);
	});

	test("restore refuses a stream with data unless forced", async () => {
		const [id] = await listBackups(target);
		if (!id) throw new Error("no backup");
		await expect(restoreBackup(b, target, id)).rejects.toThrow("--force");
		const forced = await restoreBackup(b, target, id, { force: true });
		expect(forced.replaced.length).toBe(3);
	});

	test("restore checks the sha256 first and changes nothing on a bad file", async () => {
		const [id] = await listBackups(target);
		await Bun.write(join(dir, `${id}`, "MM_WORK.snap"), "garbage");
		await expect(
			restoreBackup(b, target, id ?? "", { force: true }),
		).rejects.toThrow("sha256");
		expect((await streamInfo(b, "MM_WORK"))?.state.messages).toBe(3);
	});
});

describe("storage status", () => {
	test("warns above 80 percent of the account limit", () => {
		const gb = 1e9;
		expect(
			toStorageStatus({ storage: 8 * gb, maxStorage: 10 * gb, streams: 1 }),
		).toEqual({
			used: 8 * gb,
			limit: 10 * gb,
			percent: 80,
			warn: false,
		});
		expect(
			toStorageStatus({ storage: 8.1 * gb, maxStorage: 10 * gb, streams: 1 })
				.warn,
		).toBe(true);
		expect(
			toStorageStatus({ storage: 5, maxStorage: null, streams: 1 }),
		).toEqual({
			used: 5,
			limit: null,
			percent: null,
			warn: false,
		});
	});
});

describe.skipIf(!bin)("timer and CLI", () => {
	let source: NatsServer;
	let empty: NatsServer;
	const { target, dir } = tempTarget();
	const cli = join(import.meta.dir, "cli.ts");
	const run = async (natsUrl: string, ...args: string[]) => {
		const proc = Bun.spawn(["bun", cli, ...args], {
			env: {
				...process.env,
				NATS_WS_URL: natsUrl,
				BACKUP_URL: target.url,
				NATS_ISSUER_SEED: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out: out + err, code };
	};

	beforeAll(async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		[source, empty] = await Promise.all([startNats(bin!), startNats(bin!)]);
	});
	afterAll(() => {
		source?.stop();
		empty?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("the timer backs up and reports its last run", async () => {
		const nc = await wsconnect({ servers: source.url });
		try {
			await (await Store.open<{ q: string }>(nc, "mm_config")).put("routing", {
				q: "ops",
			});
			const lines: string[] = [];
			const backups = startBackups({
				connection: Promise.resolve(nc),
				url: target.url,
				firstDelayMs: 3_600_000,
				log: (l) => lines.push(l),
			});
			await backups.run();
			backups.stop();
			expect(backups.status().error).toBeNull();
			expect(backups.status().last?.streams).toBe(1);
			expect(lines[0]).toContain("1 streams");
		} finally {
			await nc.close();
		}
	});

	test("cli: marker, backup, list, then restore latest into an empty NATS", async () => {
		expect((await run(source.url, "marker", "write")).code).toBe(0);
		expect((await run(source.url, "backup")).code).toBe(0);
		const list = await run(source.url, "list");
		expect(list.out).toContain("2 backups");
		const restored = await run(empty.url, "restore", "latest");
		expect(restored.out).toContain("restored KV_mm_config: 1 messages");
		expect(restored.out).toContain("Restart the api");
		const check = await run(empty.url, "marker", "check");
		expect(check.code).toBe(0);
		expect(check.out).toContain("stream 1 messages");
		expect((await run(empty.url, "marker", "remove")).code).toBe(0);
		expect((await run(empty.url, "marker", "check")).code).toBe(1);
	});
});
