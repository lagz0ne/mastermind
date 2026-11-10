#!/usr/bin/env bun
// Mastermind's own Dokploy orchestration. The repo is the source of truth:
// this script talks to the Dokploy API and needs nothing else on the machine.
//
//   bun deploy/dokploy.ts status     what runs, and which env keys exist (names only)
//   bun deploy/dokploy.ts apply      create or update Dolt, NATS and the app env; deploy; verify
//   bun deploy/dokploy.ts secrets    put the redeploy hooks and the public URL into GitHub (needs `gh`)
//   bun deploy/dokploy.ts release <sha|latest>
//                                    pin the app image to the CI tag of <sha>, deploy it, show the
//                                    Dokploy queue and status, fail with the log tail, wait for health
//   bun deploy/dokploy.ts first-login  print the newest first-login URL from the app log (no account yet)
//
// Configuration, nothing is built in:
//   deploy/site.json       the site: Dokploy URL, project, service names, public host.
//                          MASTERMIND_SITE=<path> selects another file for another site.
//   DOKPLOY_API_KEY        the Dokploy API key, or
//   DOKPLOY_API_KEY_FILE   a file that holds it.
// Secrets live only in Dokploy. This script never prints a secret value; the one
// exception is `first-login`, which prints the single-use first-login URL on purpose.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createAccount, fromSeed } from "@nats-io/nkeys";
import { probe } from "./nats/smoke.ts";
import { mergeEnv, parseEnv, serializeEnv } from "./src/env.ts";
import { FIRST_LOGIN, newestFirstLogin } from "./src/first-login.ts";
import {
	type Deployment,
	describeQueue,
	findOurs,
	pinImage,
	type QueueJob,
	releaseTitle,
} from "./src/release.ts";
import { loadSite } from "./src/site.ts";

const cfg = await loadSite(
	process.env.MASTERMIND_SITE ?? join(import.meta.dir, "site.json"),
);

async function apiKey(): Promise<string> {
	if (process.env.DOKPLOY_API_KEY) return process.env.DOKPLOY_API_KEY;
	const file = process.env.DOKPLOY_API_KEY_FILE;
	if (!file)
		throw new Error(
			"no Dokploy API key: set DOKPLOY_API_KEY, or DOKPLOY_API_KEY_FILE to a file that holds it",
		);
	const f = Bun.file(file);
	if (!(await f.exists()))
		throw new Error(`DOKPLOY_API_KEY_FILE points to a missing file: ${file}`);
	return (await f.text()).trim();
}

let key: string | undefined;
async function api<T = unknown>(
	proc: string,
	input?: Record<string, unknown>,
): Promise<T> {
	key ??= await apiKey();
	const get = /\.(one|all|by[A-Z]\w*|get\w*|load\w*)$/.test(proc);
	const qs =
		get && input
			? `?${new URLSearchParams(input as Record<string, string>)}`
			: "";
	const res = await fetch(`${cfg.dokployUrl}/api/${proc}${qs}`, {
		method: get ? "GET" : "POST",
		headers: { "x-api-key": key, "content-type": "application/json" },
		body: get ? undefined : JSON.stringify(input ?? {}),
	});
	const text = await res.text();
	if (!res.ok)
		throw new Error(`dokploy ${proc}: ${res.status} ${text.slice(0, 300)}`);
	return (text ? JSON.parse(text) : undefined) as T;
}

type Service = { name: string; appName: string };
type App = Service & {
	applicationId: string;
	applicationStatus: string;
	env: string | null;
	buildArgs: string | null;
	buildSecrets: string | null;
	createEnvFile: boolean;
	refreshToken: string;
	serverId?: string | null;
	mounts?: { mountPath: string }[];
	dockerImage?: string | null;
	username?: string | null;
	password?: string | null;
	registryUrl?: string | null;
};
type Compose = Service & {
	composeId: string;
	composeStatus: string;
	env: string | null;
	refreshToken: string;
};
type Domain = {
	domainId: string;
	host: string;
	path: string | null;
	port: number | null;
	serviceName: string | null;
};
type Project = {
	name: string;
	environments: {
		name: string;
		environmentId: string;
		applications: App[];
		compose: Compose[];
	}[];
};

async function findProject() {
	const projects = await api<Project[]>("project.all");
	const project = projects.find((p) => p.name === cfg.project);
	if (!project) throw new Error(`Dokploy project '${cfg.project}' not found`);
	const env =
		project.environments.find((e) => e.name === "production") ??
		project.environments[0];
	if (!env) throw new Error(`project '${cfg.project}' has no environment`);
	return {
		environmentId: env.environmentId,
		applicationId: env.applications.find((a) => a.name === cfg.app)
			?.applicationId,
		natsId: env.applications.find((a) => a.name === cfg.nats)?.applicationId,
		composeId: env.compose.find((c) => c.name === cfg.infra)?.composeId,
	};
}

const secret = () => randomBytes(24).toString("hex");
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An error that waiting cannot fix: stop at once. */
class Fatal extends Error {}

async function waitFor<T>(
	what: string,
	seconds: number,
	probeOnce: () => Promise<T | undefined>,
): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const value = await probeOnce();
			if (value !== undefined) return value;
		} catch (error) {
			if (error instanceof Fatal) throw error;
			lastError = String(error);
		}
		await sleep(3000);
	}
	throw new Error(
		`timed out after ${seconds}s waiting for ${what}${lastError ? ` (${lastError})` : ""}`,
	);
}

/** Where the infra compose is in this repo. */
const composePath = "./deploy/compose.yml";
const publicHost = new URL(cfg.publicUrl).host;
const natsPublicUrl = `${cfg.publicUrl.replace(/^http/, "ws")}/nats`;

async function health(): Promise<Record<string, unknown>> {
	const res = await fetch(`${cfg.publicUrl}/api/health`, {
		signal: AbortSignal.timeout(10_000),
	});
	return (await res.json()) as Record<string, unknown>;
}

const keys = (env: string | null) =>
	[...parseEnv(env).keys()].join(", ") || "(none)";

async function status() {
	const ids = await findProject();
	log(`dokploy ${cfg.dokployUrl}  project ${cfg.project}`);
	for (const [label, id] of [
		["app", ids.applicationId],
		["nats", ids.natsId],
	] as const) {
		if (!id) {
			log(`  ${label.padEnd(8)} MISSING (run: bun deploy/dokploy.ts apply)`);
			continue;
		}
		const app = await api<App>("application.one", { applicationId: id });
		log(
			`  ${label.padEnd(8)} ${app.name}: ${app.applicationStatus}  host ${app.appName}  env: ${keys(app.env)}`,
		);
		for (const d of await api<Domain[]>("domain.byApplicationId", {
			applicationId: id,
		}))
			log(
				`  route    https://${d.host}${d.path && d.path !== "/" ? d.path : ""} → ${app.name}:${d.port}`,
			);
	}
	if (ids.composeId) {
		const infra = await api<Compose>("compose.one", {
			composeId: ids.composeId,
		});
		log(
			`  infra    ${infra.name}: ${infra.composeStatus}  env: ${keys(infra.env)}`,
		);
	} else
		log(`  infra    ${cfg.infra}: MISSING (run: bun deploy/dokploy.ts apply)`);
	log(
		`  health   ${JSON.stringify(await health().catch((e) => ({ error: String(e) })))}`,
	);
}

async function deployApp(applicationId: string, why: string) {
	await api("application.deploy", {
		applicationId,
		title: `deploy/dokploy.ts apply (${why})`,
	});
	await sleep(3000);
	await waitFor(`the deploy of ${applicationId}`, 600, async () => {
		const a = await api<App>("application.one", { applicationId });
		if (a.applicationStatus === "error")
			throw new Fatal(
				`Dokploy reports that the deploy of ${a.name} failed; read its build log in Dokploy`,
			);
		return a.applicationStatus === "done" ? true : undefined;
	});
}

async function apply() {
	const ids = await findProject();
	if (!ids.applicationId)
		throw new Error(`app '${cfg.app}' not found in project '${cfg.project}'`);

	// 1. The infra compose (Dolt): source = this repo, so Dokploy runs what is on main.
	let composeId = ids.composeId;
	if (!composeId) {
		const created = await api<Compose>("compose.create", {
			name: cfg.infra,
			environmentId: ids.environmentId,
			composeType: "docker-compose",
			appName: cfg.infra,
		});
		composeId = created.composeId;
		log(`infra: created compose ${cfg.infra}`);
	}
	const infra = await api<Compose>("compose.one", { composeId });
	const infraEnv = mergeEnv(parseEnv(infra.env), {
		keep: { DOLT_ROOT_PASSWORD: secret },
		drop: ["NATS_AUTH_PASSWORD", "NATS_ISSUER_SEED", "NATS_ISSUER_PUBLIC"],
	});
	await api("compose.update", {
		composeId,
		sourceType: "git",
		customGitUrl: cfg.repo,
		customGitBranch: cfg.branch,
		composePath: composePath,
		autoDeploy: true,
		env: serializeEnv(infraEnv.env),
	});
	// This Traefik reads only Dokploy's route files, so a route on a compose service does nothing.
	for (const d of await api<Domain[]>("domain.byComposeId", { composeId })) {
		await api("domain.delete", { domainId: d.domainId });
		log(`infra: removed dead route ${d.host}${d.path ?? ""}`);
	}
	log(
		`infra: source ${cfg.repo}@${cfg.branch} ${composePath}; env ${infraEnv.changed.length ? `changed ${infraEnv.changed.join(", ")}` : "unchanged"}`,
	);
	await api("compose.deploy", { composeId, title: "deploy/dokploy.ts apply" });
	await sleep(3000);
	await waitFor("the infra deploy", 600, async () => {
		const c = await api<Compose>("compose.one", { composeId });
		if (c.composeStatus === "error")
			throw new Fatal(
				"Dokploy reports that the compose deploy failed; read its log in Dokploy",
			);
		return c.composeStatus === "done" ? true : undefined;
	});
	log("infra: deployed");

	// 2. The app holds the NATS secrets. Existing values win, so apply never rotates them.
	const app = await api<App>("application.one", {
		applicationId: ids.applicationId,
	});
	const withSecrets = mergeEnv(parseEnv(app.env), {
		keep: {
			NATS_AUTH_PASSWORD: secret,
			NATS_ISSUER_SEED: () =>
				new TextDecoder().decode(createAccount().getSeed()),
		},
	});
	const natsPassword = withSecrets.env.get("NATS_AUTH_PASSWORD") ?? "";
	const seed = withSecrets.env.get("NATS_ISSUER_SEED") ?? "";

	// 3. NATS: a Dokploy application built from deploy/nats, public only as wss://<host>/nats.
	let natsId = ids.natsId;
	let natsChanged = false;
	if (!natsId) {
		const created = await api<App>("application.create", {
			name: cfg.nats,
			appName: cfg.nats,
			environmentId: ids.environmentId,
		});
		natsId = created.applicationId;
		natsChanged = true;
		log(`nats: created application ${cfg.nats}`);
	}
	await api("application.saveGitProvider", {
		applicationId: natsId,
		customGitUrl: cfg.repo,
		customGitBranch: cfg.branch,
		customGitBuildPath: "/",
		watchPaths: [],
		enableSubmodules: false,
	});
	await api("application.saveBuildType", {
		applicationId: natsId,
		buildType: "dockerfile",
		dockerfile: "deploy/nats/Dockerfile",
		dockerContextPath: ".",
		dockerBuildStage: "",
		herokuVersion: null,
		railpackVersion: null,
	});
	const nats = await api<App>("application.one", { applicationId: natsId });
	const natsEnv = mergeEnv(parseEnv(nats.env), {
		set: {
			NATS_AUTH_PASSWORD: natsPassword,
			NATS_ISSUER_PUBLIC: fromSeed(
				new TextEncoder().encode(seed),
			).getPublicKey(),
		},
	});
	if (natsEnv.changed.length) {
		await api("application.saveEnvironment", {
			applicationId: natsId,
			env: serializeEnv(natsEnv.env),
			buildArgs: nats.buildArgs ?? "",
			buildSecrets: nats.buildSecrets ?? "",
			createEnvFile: nats.createEnvFile ?? false,
		});
		natsChanged = true;
	}
	if (!nats.mounts?.some((m) => m.mountPath === "/data/jetstream")) {
		await api("mounts.create", {
			type: "volume",
			volumeName: `${cfg.nats}-data`,
			mountPath: "/data/jetstream",
			serviceType: "application",
			serviceId: natsId,
		});
		natsChanged = true;
	}
	const natsDomains = await api<Domain[]>("domain.byApplicationId", {
		applicationId: natsId,
	});
	if (!natsDomains.some((d) => d.host === publicHost && d.path === "/nats")) {
		await api("domain.create", {
			host: publicHost,
			path: "/nats",
			port: 8080,
			https: true,
			certificateType: "none",
			applicationId: natsId,
		});
		natsChanged = true;
		log(`nats: route ${natsPublicUrl} → :8080`);
	}
	if (natsChanged || nats.applicationStatus !== "done") {
		await deployApp(natsId, "nats");
		log("nats: deployed");
	} else log("nats: unchanged");

	// 4. Point the app at both. Keys this script does not know (DATABASE_URL, ...) are left alone.
	const appEnv = mergeEnv(withSecrets.env, {
		set: {
			DOLT_URL: `mysql://root:${infraEnv.env.get("DOLT_ROOT_PASSWORD")}@mastermind-dolt:3306/mastermind`,
			DOLT_BACKUP_URL: "file:///backups/mastermind",
			NATS_URL: `nats://${nats.appName}:4222`,
			// @mastermind/bus connects over WebSocket only.
			NATS_WS_URL: `ws://${nats.appName}:8080`,
			NATS_AUTH_USER: "mastermind",
			PUBLIC_URL: cfg.publicUrl,
			...cfg.appEnv,
			NATS_PUBLIC_WS_URL: `${natsPublicUrl}`,
		},
	});
	const appChanged = [...withSecrets.changed, ...appEnv.changed];
	if (appChanged.length) {
		await api("application.saveEnvironment", {
			applicationId: ids.applicationId,
			env: serializeEnv(appEnv.env),
			buildArgs: app.buildArgs ?? "",
			buildSecrets: app.buildSecrets ?? "",
			createEnvFile: app.createEnvFile ?? false,
		});
		log(`app: env changed ${appChanged.join(", ")}; redeploying`);
		await deployApp(ids.applicationId, "env");
	} else log("app: env unchanged");

	// 5. Verify from outside.
	const h = await waitFor("health dolt=up bd=up", 300, async () => {
		const now = await health();
		return now.dolt === "up" && now.bd === "up" ? now : undefined;
	});
	log(`ok: health ${JSON.stringify(h)}`);
	const reply = await waitFor(
		"the public NATS WebSocket",
		120,
		async () => (await probe(`${natsPublicUrl}`)).reply,
	);
	if (!reply.includes("Authorization Violation"))
		throw new Error(`NATS let an unauthenticated client in: ${reply}`);
	log(`ok: ${natsPublicUrl} answers and refuses unauthenticated clients`);
}

async function deploymentLog(deploymentId: string, tail: number) {
	const text = await api<string>("deployment.readLogs", {
		deploymentId,
		tail: String(tail),
	}).catch((e) => `(no log: ${e})`);
	return String(text)
		.trimEnd()
		.split("\n")
		.map((l) => `  | ${l}`)
		.join("\n");
}

/**
 * Deploy the image of ONE commit (not :latest), so the record says what runs. Dokploy runs one
 * deployment at a time for all its projects, so ours may wait behind other builds: say so.
 */
async function release(ref = "") {
	const { applicationId } = await findProject();
	if (!applicationId)
		throw new Error(`app '${cfg.app}' not found in project '${cfg.project}'`);
	const app = await api<App>("application.one", { applicationId });
	const image = pinImage(app.dockerImage ?? "", ref);
	if (app.dockerImage !== image) {
		await api("application.saveDockerProvider", {
			applicationId,
			dockerImage: image,
			username: app.username ?? null,
			password: app.password ?? null,
			registryUrl: app.registryUrl ?? null,
		});
	}
	log(`app: image ${image}`);
	const title = releaseTitle(ref);
	const askedAt = Date.now();
	await api("application.deploy", {
		applicationId,
		title,
		description: `Commit: ${ref}`,
	});

	const minutes = Number(process.env.RELEASE_WAIT_MINUTES ?? 20);
	const deadline = askedAt + minutes * 60_000;
	let said = "";
	const say = (line: string) => {
		if (line !== said) log(`${new Date().toISOString().slice(11, 19)} ${line}`);
		said = line;
	};
	let ours: Deployment | undefined;
	while (Date.now() < deadline) {
		ours = findOurs(
			await api<Deployment[]>("deployment.all", { applicationId }),
			title,
			askedAt,
		);
		if (ours?.status === "error") {
			log(await deploymentLog(ours.deploymentId, 60));
			throw new Error(
				`Dokploy deployment ${ours.deploymentId} failed${ours.errorMessage ? `: ${ours.errorMessage}` : ""}`,
			);
		}
		if (ours?.status === "done") break;
		say(
			ours
				? `dokploy: ${ours.status} (${ours.deploymentId})`
				: describeQueue(
						await api<QueueJob[]>("deployment.queueList").catch(() => []),
						applicationId,
					),
		);
		await sleep(5000);
	}
	if (ours?.status !== "done")
		throw new Error(
			`no finished Dokploy deployment after ${minutes} min (last: ${said || "none"})`,
		);
	log(`dokploy: done (${ours.deploymentId})`);
	log(await deploymentLog(ours.deploymentId, 15));
	if (ref === "latest") return;

	// Done means the swarm service was updated. It serves the commit only once the new task is up.
	let last: unknown;
	try {
		const h = await waitFor(
			`health version ${ref.slice(0, 7)}`,
			300,
			async () => {
				last = await health();
				const now = last as Record<string, unknown>;
				return now.version === ref && now.ok === true ? now : undefined;
			},
		);
		log(`ok: health ${JSON.stringify(h)}`);
	} catch (error) {
		log(`last health: ${JSON.stringify(last)}`);
		const tail = await api<string>("application.readLogs", {
			applicationId,
			tail: "40",
			since: "10m",
		}).catch((e) => `(no log: ${e})`);
		log(`app log (last 10 min):\n${String(tail).trimEnd()}`);
		throw error;
	}
}

/** `gh` may be logged in to several accounts; use the one that owns the repo when it is there. */
async function ghEnv(): Promise<Record<string, string | undefined>> {
	const owner = new URL(cfg.repo).pathname.split("/")[1] ?? "";
	const proc = Bun.spawn(["gh", "auth", "token", "--user", owner], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const token = (await new Response(proc.stdout).text()).trim();
	return (await proc.exited) === 0 && token
		? { ...process.env, GH_TOKEN: token }
		: process.env;
}

/** Put the redeploy hooks into the GitHub environment. The URLs go through stdin, not argv. */
async function secrets() {
	const ids = await findProject();
	if (!ids.applicationId || !ids.composeId || !ids.natsId)
		throw new Error("run apply first");
	const app = await api<App>("application.one", {
		applicationId: ids.applicationId,
	});
	const nats = await api<App>("application.one", { applicationId: ids.natsId });
	const infra = await api<Compose>("compose.one", { composeId: ids.composeId });
	const hooks = {
		DOKPLOY_DEPLOY_HOOK: `${cfg.dokployUrl}/api/deploy/${app.refreshToken}`,
		DOKPLOY_NATS_HOOK: `${cfg.dokployUrl}/api/deploy/${nats.refreshToken}`,
		DOKPLOY_INFRA_HOOK: `${cfg.dokployUrl}/api/deploy/compose/${infra.refreshToken}`,
	};
	const env = await ghEnv();
	for (const [name, value] of Object.entries(hooks)) {
		const proc = Bun.spawn(
			["gh", "secret", "set", name, "--env", cfg.githubEnvironment],
			{
				stdin: new TextEncoder().encode(value),
				stdout: "ignore",
				stderr: "inherit",
				env,
			},
		);
		if ((await proc.exited) !== 0)
			throw new Error(`gh secret set ${name} failed`);
		log(`github: ${name} set on environment ${cfg.githubEnvironment}`);
	}
	const variable = Bun.spawn(
		[
			"gh",
			"variable",
			"set",
			"PUBLIC_URL",
			"--env",
			cfg.githubEnvironment,
			"--body",
			cfg.publicUrl,
		],
		{ stdout: "ignore", stderr: "inherit", env },
	);
	if ((await variable.exited) !== 0)
		throw new Error("gh variable set PUBLIC_URL failed");
	log(
		`github: variable PUBLIC_URL=${cfg.publicUrl} set on environment ${cfg.githubEnvironment}`,
	);
}

/**
 * Read up to `tail` lines of a container or swarm service log through the
 * Dokploy log socket (the one its UI uses), filtered by `search`. The socket
 * follows the log, so stop when it goes quiet.
 */
async function dockerLogs(q: {
	containerId: string;
	runType: "swarm" | "native";
	search: string;
	serverId?: string | null;
	tail?: number;
}): Promise<string> {
	key ??= await apiKey();
	const params = new URLSearchParams({
		containerId: q.containerId,
		tail: String(q.tail ?? 10_000),
		since: "all",
		search: q.search,
		runType: q.runType,
	});
	if (q.serverId) params.set("serverId", q.serverId);
	const url = `${cfg.dokployUrl.replace(/^http/, "ws")}/docker-container-logs?${params}`;
	const ws = new WebSocket(url, { headers: { "x-api-key": key } });
	let text = "";
	return await new Promise<string>((resolve, reject) => {
		let idle: Timer | undefined;
		const done = () => {
			clearTimeout(idle);
			clearTimeout(cap);
			ws.close();
			resolve(text);
		};
		const quiet = () => {
			clearTimeout(idle);
			idle = setTimeout(done, 3_000);
		};
		const cap = setTimeout(done, 30_000);
		ws.onopen = quiet;
		ws.onmessage = (e) => {
			text += String(e.data);
			quiet();
		};
		ws.onerror = () => {
			clearTimeout(idle);
			clearTimeout(cap);
			reject(new Error(`dokploy log socket failed for ${q.containerId}`));
		};
		ws.onclose = done;
	});
}

/**
 * While no account exists, every start of the app logs a new single-use
 * login URL (and the previous one stops working). Print the newest one.
 */
async function firstLogin() {
	const setup = (await fetch(`${cfg.publicUrl}/api/people/setup`, {
		signal: AbortSignal.timeout(10_000),
	})
		.then((r) => r.json())
		.catch(() => null)) as { auth?: string; firstLogin?: boolean } | null;
	if (setup?.auth === "on" && setup.firstLogin === false) {
		log(
			"first-login: an account exists, so no first-login token is minted. Ask an account to invite you.",
		);
		return;
	}
	if (setup && setup.auth !== "on")
		log(`first-login: auth on ${cfg.publicUrl} is '${setup.auth}'`);

	const { applicationId } = await findProject();
	if (!applicationId) throw new Error(`no app '${cfg.app}' in Dokploy`);
	const app = await api<App>("application.one", { applicationId });
	const search = FIRST_LOGIN;
	let found = newestFirstLogin(
		await dockerLogs({
			containerId: app.appName,
			runType: "swarm",
			search,
			serverId: app.serverId,
		}),
	);
	if (found.kind === "none") {
		// Not a swarm service: read each container of the app.
		const containers = await api<{ containerId: string }[]>(
			"docker.getContainersByAppNameMatch",
			{
				appName: app.appName,
				...(app.serverId ? { serverId: app.serverId } : {}),
			},
		);
		let all = "";
		for (const c of containers)
			all += `${await dockerLogs({ containerId: c.containerId, runType: "native", search, serverId: app.serverId })}\n`;
		found = newestFirstLogin(all);
	}
	if (found.kind === "url") {
		log(
			`first-login: open this once (single use; a restart of the app replaces it)${found.at ? `, logged ${found.at}` : ""}:`,
		);
		log(found.url);
	} else if (found.kind === "not-needed")
		log("first-login: an account exists, so no first-login token is minted.");
	else
		throw new Error(
			"no first-login line in the app log. Restart the app (bun deploy/dokploy.ts apply, or redeploy) and run this again.",
		);
}

const commands: Record<string, () => Promise<void>> = {
	status,
	apply,
	secrets,
	"first-login": firstLogin,
	release: () => release(process.argv[3]),
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
	console.error(
		"usage: bun deploy/dokploy.ts status | apply | secrets | first-login | release <sha|latest>",
	);
	process.exit(2);
}
await command().catch((error) => {
	console.error(`dokploy: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
