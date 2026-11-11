import { browserIngest, telemetryFromEnv, traced } from "@mastermind/telemetry";
import index from "@mastermind/web/index.html";
import { type Deps, health } from "./app.ts";
import type { Auth } from "./auth/service.ts";
import { requireAccountFromEnv } from "./auth/session.ts";
import { startAuthInBackground } from "./auth/start.ts";
import { backupsFromEnv, jetstreamHealth } from "./backup/start.ts";
import { beadsRoutes } from "./beads/routes.ts";
import { boardRoutes } from "./board/routes.ts";
import type { DispatchNats } from "./dispatch/start.ts";
import { downloadRoutes } from "./download/routes.ts";
import { environmentRoutes } from "./environments/routes.ts";
import { startEnvironmentsInBackground } from "./environments/start.ts";
import { exitOnNatsClosed } from "./nats-exit.ts";
import { RunnerRegistry } from "./people/registry.ts";
import { peopleRoutes } from "./people/routes.ts";
import { runnerScript } from "./people/runner-script.ts";
import { routingRoutes } from "./routing/routes.ts";
import { startRoutingInBackground } from "./routing/start.ts";
import { startNatsWork } from "./store/nats-work.ts";

const env = process.env;
const version = env.GIT_SHA ?? "dev";
// OTLP logs, traces and metrics: no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
const telemetry = telemetryFromEnv(env, {
	serviceName: env.OTEL_SERVICE_NAME || "mastermind",
	serviceVersion: version,
});
const webTelemetry = telemetryFromEnv(env, {
	serviceName: "mastermind-web",
	serviceVersion: version,
});

const deps: Deps = { nats: null, work: null };

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
				operatorKey: env.MASTERMIND_OPERATOR_KEY,
				// The connections reconnect forever; one that still closes is dead,
				// so exit and let the orchestrator start a new process (mm-210.38).
				onClosed: exitOnNatsClosed(),
			})
		: null;

// Session check for every /api route outside /api/auth. Without auth: 503,
// unless AUTH_DISABLED=1 (local dev: every request is account "local").
export const requireAccount = requireAccountFromEnv(auth, env);
if (!auth && env.AUTH_DISABLED === "1")
	console.warn("auth: AUTH_DISABLED=1, every /api request is account local");

// /people: accounts and the live runner list (the dispatcher feeds the registry).
const runners = new RunnerRegistry();
let authNow: Auth | null = null;
auth?.ready.then((s) => (authNow = s.auth)).catch(() => {});
const people = peopleRoutes({
	requireAccount,
	auth: () => authNow,
	mode: auth ? "on" : env.AUTH_DISABLED === "1" ? "off" : "unconfigured",
	registry: runners,
	runnerScript: runnerScript(),
	version,
	onError: (error) => console.error(`people: ${error}`),
});

// The work store and its dispatcher on NATS, on auth's APP connection; without
// auth, on DISPATCH_NATS_URL (ws/wss, local dev). Off when neither is set.
const dispatchNats: DispatchNats | null = auth
	? { connection: auth.ready.then((service) => service.app) }
	: env.DISPATCH_NATS_URL
		? {
				url: env.DISPATCH_NATS_URL,
				user: env.DISPATCH_NATS_USER,
				pass: env.DISPATCH_NATS_PASSWORD,
			}
		: null;
// The store and its dispatcher open in the background on this NATS.
const natsWork = dispatchNats
	? startNatsWork({
			nats: dispatchNats,
			observe: runners.observe,
			onError: (error) => console.error(`work: ${error}`),
		})
	: null;
if (!natsWork)
	console.error(
		"work: the work store needs NATS (auth or DISPATCH_NATS_URL); work is off",
	);
deps.work = natsWork ? natsWork.probe : null;
deps.nats = natsWork ? natsWork.dispatchProbe : null;
const board = boardRoutes(natsWork ? natsWork.board : null, {
	onError: (error) => console.error(`board: ${error}`),
});
// Routing (queues, members, ordered rules) in NATS KV, on the dispatcher's NATS.
const routing = dispatchNats ? startRoutingInBackground(dispatchNats) : null;
const routingApi = routingRoutes({
	store: () => routing?.store() ?? null,
	beads: natsWork ? natsWork.routing : null,
	requireAccount,
	onError: (error) => console.error(`routing: ${error}`),
});

// Environments (named repo/ref/setup/check definitions) in NATS KV, next to routing.
const environments = dispatchNats
	? startEnvironmentsInBackground(dispatchNats)
	: null;
const environmentsApi = environmentRoutes({
	store: () => environments?.store() ?? null,
	requireAccount,
	onError: (error) => console.error(`environments: ${error}`),
});

// JetStream backups (BACKUP_URL) and storage use in health, on auth's APP connection.
const appNats = auth ? auth.ready.then((service) => service.app) : null;
const backups = appNats ? backupsFromEnv(env, appNats) : null;
deps.jetstream = appNats ? () => jetstreamHealth(appNats, backups) : null;

// Work from the UI: /api/beads (create, detail with timeline, notes, reopen, close) and /api/activity.
const beads = beadsRoutes(natsWork ? natsWork.beads : null, {
	requireAccount,
	onError: (error) => console.error(`beads: ${error}`),
});

const server = Bun.serve({
	port,
	development: env.NODE_ENV !== "production",
	routes: traced(
		telemetry,
		{
			"/api/health": async () => {
				const res = await health(deps, version);
				// The container healthcheck asks every 15 s; alert on ok=false (docs/deploy.md).
				telemetry.count("mastermind.health.checks", 1, {
					ok: String(res.ok),
				});
				return res;
			},
			...board.routes,
			...people,
			...routingApi,
			...environmentsApi,
			...beads,
			// Public: /install.sh and the runner binaries of this commit.
			...downloadRoutes({
				version,
				onError: (error) => console.error(`download: ${error}`),
			}),
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
		backups?.stop();
		await natsWork?.stop();
		await routing?.stop();
		await environments?.stop();
		await auth?.stop();
		board.stop();
		await server.stop();
		await Promise.all([telemetry.shutdown(), webTelemetry.shutdown()]);
		process.exit(0);
	});
}

console.log(
	`mastermind ${version} listening on ${server.url}${telemetry.enabled ? ` (otlp ${env.OTEL_EXPORTER_OTLP_ENDPOINT})` : ""}`,
);
