import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserIngest, telemetryFromEnv, traced } from "@mastermind/telemetry";
import index from "@mastermind/web/index.html";
import { SQL } from "bun";
import { type Deps, health } from "./app.ts";
import { startAuthInBackground } from "./auth/start.ts";
import {
	bdEnv,
	bootstrap,
	type Supervisor,
	serveCmd,
	supervise,
	writeWorkspace,
} from "./bd-serve.ts";
import { boardRoutes, doltBoardSource } from "./board/routes.ts";
import { runDispatch } from "./dispatch/start.ts";
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
// OTLP logs, traces and metrics: no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
const telemetry = telemetryFromEnv(env, {
	serviceName: env.OTEL_SERVICE_NAME || "mastermind",
	serviceVersion: version,
});
const webTelemetry = telemetryFromEnv(env, {
	serviceName: "mastermind-web",
	serviceVersion: version,
});

const deps: Deps = {
	db: env.DATABASE_URL ? new SQL(env.DATABASE_URL) : null,
	// Configured means probed: until bd serve is up, health reports it down.
	dolt: env.DOLT_URL ? new SQL(env.DOLT_URL) : null,
	bdUrl: env.DOLT_URL ? `http://127.0.0.1:${bdPort}` : null,
	nats: null,
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

// Dispatcher on NATS: off unless DISPATCH_NATS_URL (ws/wss) is set; needs Dolt and bd serve.
const hub = board.hub;
const dispatch =
	env.DISPATCH_NATS_URL && deps.dolt && deps.bdUrl
		? runDispatch({
				natsUrl: env.DISPATCH_NATS_URL,
				user: env.DISPATCH_NATS_USER,
				pass: env.DISPATCH_NATS_PASSWORD,
				bdUrl: deps.bdUrl,
				dolt: deps.dolt,
				events: hub
					? (listener) => hub.subscribe(listener).unsubscribe
					: undefined,
				onError: (error) => console.error(`dispatch: ${error}`),
			})
		: null;
deps.nats = dispatch ? () => dispatch.probe() : null;

// Auth (NATS auth callout + /api/auth/*): off unless NATS_WS_URL (ws/wss), the issuer seed and the auth password are set.
const port = Number(env.PORT ?? 3000);
const auth =
	env.NATS_WS_URL && env.NATS_ISSUER_SEED && env.NATS_AUTH_PASSWORD
		? startAuthInBackground({
				natsUrl: env.NATS_WS_URL,
				authUser: env.NATS_AUTH_USER ?? "mastermind",
				authPassword: env.NATS_AUTH_PASSWORD,
				issuerSeed: env.NATS_ISSUER_SEED,
				publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(
					/\/$/,
					"",
				),
				publicNatsUrl: env.NATS_PUBLIC_WS_URL,
			})
		: null;

const server = Bun.serve({
	port,
	development: env.NODE_ENV !== "production",
	routes: traced(
		telemetry,
		{
			"/api/health": () => health(deps, version),
			...board.routes,
			// Empty when auth is off; the cast only keeps the route keys typed.
			...(auth?.routes ?? ({} as NonNullable<typeof auth>["routes"])),
			// Browser vitals, errors and route timings, forwarded as mastermind-web.
			"/api/telemetry": { POST: browserIngest(webTelemetry) },
			"/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
			"/*": index,
		},
		{ skip: ["/api/telemetry"] },
	),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (backupTimer) clearInterval(backupTimer);
		await dispatch?.stop();
		await auth?.stop();
		board.stop();
		await server.stop();
		await bd?.stop();
		await deps.db?.close();
		await deps.dolt?.close();
		await Promise.all([telemetry.shutdown(), webTelemetry.shutdown()]);
		process.exit(0);
	});
}

console.log(
	`mastermind ${version} listening on ${server.url}${telemetry.enabled ? ` (otlp ${env.OTEL_EXPORTER_OTLP_ENDPOINT})` : ""}`,
);
