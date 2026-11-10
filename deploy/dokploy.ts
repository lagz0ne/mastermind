#!/usr/bin/env bun
// Mastermind's own Dokploy orchestration. The repo is the source of truth:
// this script talks to the Dokploy API and needs nothing else on the machine.
//
//   bun deploy/dokploy.ts status     what runs, and which env keys exist (names only)
//   bun deploy/dokploy.ts apply      create or update Dolt, NATS and the app env; deploy; verify
//   bun deploy/dokploy.ts secrets    put the redeploy hooks and the public URL into GitHub (needs `gh`)
//
// Configuration, nothing is built in:
//   deploy/site.json       the site: Dokploy URL, project, service names, public host.
//                          MASTERMIND_SITE=<path> selects another file for another site.
//   DOKPLOY_API_KEY        the Dokploy API key, or
//   DOKPLOY_API_KEY_FILE   a file that holds it.
// Secrets live only in Dokploy. This script never prints a secret value.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createAccount, fromSeed } from "@nats-io/nkeys";
import { probe } from "./nats/smoke.ts";
import { mergeEnv, parseEnv, serializeEnv } from "./src/env.ts";
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
	mounts?: { mountPath: string }[];
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

const commands: Record<string, () => Promise<void>> = {
	status,
	apply,
	secrets,
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
	console.error("usage: bun deploy/dokploy.ts status | apply | secrets");
	process.exit(2);
}
await command().catch((error) => {
	console.error(`dokploy: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
