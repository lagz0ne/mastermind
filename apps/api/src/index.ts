import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "@mastermind/web/index.html";
import { SQL } from "bun";
import { type Deps, health } from "./app.ts";
import {
	bdEnv,
	bootstrap,
	type Supervisor,
	serveCmd,
	supervise,
	writeWorkspace,
} from "./bd-serve.ts";
import { boardRoutes, doltBoardSource } from "./board/routes.ts";
import {
	ensureBackup,
	hasBeadsSchema,
	parseDoltUrl,
	serverUrl,
	syncBackup,
} from "./dolt.ts";

const env = process.env;
const version = env.GIT_SHA ?? "dev";
const bdPort = Number(env.BD_SERVE_PORT ?? 3010);

const deps: Deps = {
	db: env.DATABASE_URL ? new SQL(env.DATABASE_URL) : null,
	// Configured means probed: until bd serve is up, health reports it down.
	dolt: env.DOLT_URL ? new SQL(env.DOLT_URL) : null,
	bdUrl: env.DOLT_URL ? `http://127.0.0.1:${bdPort}` : null,
};

let bd: Supervisor | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;

/** Bootstrap the beads database if needed, then supervise bd serve. */
async function startBeads(doltUrl: string): Promise<void> {
	const target = parseDoltUrl(doltUrl);
	const bin = env.BD_BIN ?? "bd";
	const server = new SQL(serverUrl(doltUrl));
	try {
		if (!(await hasBeadsSchema(server, target.database))) {
			console.log(`dolt: creating beads database ${target.database}`);
			await bootstrap(bin, target, env.BD_PREFIX ?? "mm");
		}
	} finally {
		await server.close();
	}
	const root = env.BD_WORKSPACE ?? join(tmpdir(), "mastermind-beads");
	const beadsDir = await writeWorkspace(root, target.database);
	bd = supervise({
		cmd: serveCmd(bin, bdPort),
		port: bdPort,
		cwd: root,
		env: bdEnv(target, beadsDir),
	});
}

async function backup(sql: SQL, url: string): Promise<void> {
	const started = performance.now();
	await ensureBackup(sql, url);
	await syncBackup(sql);
	console.log(
		`dolt: backup synced to ${url} in ${Math.round(performance.now() - started)}ms`,
	);
}

async function startDolt(doltUrl: string): Promise<void> {
	// Dolt may come up after the app; keep trying instead of crashing.
	for (let attempt = 1; ; attempt++) {
		try {
			await startBeads(doltUrl);
			break;
		} catch (error) {
			const wait = Math.min(1_000 * 2 ** attempt, 60_000);
			console.error(`dolt: start failed (${error}); retrying in ${wait}ms`);
			await Bun.sleep(wait);
		}
	}
	const backupUrl = env.DOLT_BACKUP_URL;
	const sql = deps.dolt;
	if (!backupUrl || !sql) return;
	const run = () =>
		backup(sql, backupUrl).catch((error) =>
			console.error(`dolt: backup failed: ${error}`),
		);
	await run();
	const minutes = Number(env.DOLT_BACKUP_INTERVAL_MINUTES ?? 360);
	backupTimer = setInterval(run, minutes * 60_000);
}

if (env.DOLT_URL) void startDolt(env.DOLT_URL);

const board = boardRoutes(deps.dolt ? doltBoardSource(deps.dolt) : null, {
	onError: (error) => console.error(`board: ${error}`),
});

const server = Bun.serve({
	port: Number(env.PORT ?? 3000),
	development: env.NODE_ENV !== "production",
	routes: {
		"/api/health": () => health(deps, version),
		...board.routes,
		"/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
		"/*": index,
	},
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (backupTimer) clearInterval(backupTimer);
		board.stop();
		await server.stop();
		await bd?.stop();
		await deps.db?.close();
		await deps.dolt?.close();
		process.exit(0);
	});
}

console.log(`mastermind ${version} listening on ${server.url}`);
