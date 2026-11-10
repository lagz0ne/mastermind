#!/usr/bin/env bun
// Mastermind's own Dokploy orchestration. The repo is the source of truth:
// this script talks to the Dokploy API and needs nothing else on the machine.
//
//   bun deploy/dokploy.ts status     what runs, and which env keys exist (names only)
//   bun deploy/dokploy.ts apply      create or update the infra stack + app env, deploy, verify
//   bun deploy/dokploy.ts secrets    put the two deploy hooks into GitHub (needs `gh`)
//
// Auth: DOKPLOY_API_KEY, or a file named by DOKPLOY_API_KEY_FILE
// (default ~/.config/secrets/dokploy-api). DOKPLOY_URL defaults to https://dokploy.vibea.dev.
// Secrets live only in Dokploy. This script never prints a secret value.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { createAccount, fromSeed } from "@nats-io/nkeys";
import { type Env, mergeEnv, parseEnv, serializeEnv } from "./src/env.ts";

const cfg = {
	url: (process.env.DOKPLOY_URL ?? "https://dokploy.vibea.dev").replace(
		/\/$/,
		"",
	),
	project: "mastermind",
	app: "mastermind",
	infra: "mastermind-infra",
	repo: "https://github.com/lagz0ne/mastermind.git",
	branch: "main",
	composePath: "./deploy/compose.yml",
	host: "mastermind.vibea.dev",
	githubEnvironment: "production",
};

async function apiKey(): Promise<string> {
	if (process.env.DOKPLOY_API_KEY) return process.env.DOKPLOY_API_KEY;
	const file =
		process.env.DOKPLOY_API_KEY_FILE ??
		`${homedir()}/.config/secrets/dokploy-api`;
	const f = Bun.file(file);
	if (!(await f.exists()))
		throw new Error(
			`no Dokploy API key: set DOKPLOY_API_KEY or put it in ${file}`,
		);
	return (await f.text()).trim();
}

let key: string | undefined;
async function api<T = unknown>(
	proc: string,
	input?: Record<string, unknown>,
	method?: "GET" | "POST",
): Promise<T> {
	key ??= await apiKey();
	const get = method
		? method === "GET"
		: /\.(one|all|by[A-Z]\w*|get\w*|load\w*)$/.test(proc);
	const qs =
		get && input
			? `?${new URLSearchParams(input as Record<string, string>)}`
			: "";
	const res = await fetch(`${cfg.url}/api/${proc}${qs}`, {
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
};
type Compose = Service & {
	composeId: string;
	composeStatus: string;
	env: string | null;
	refreshToken: string;
};
type Domain = {
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
		composeId: env.compose.find((c) => c.name === cfg.infra)?.composeId,
	};
}

const secret = () => randomBytes(24).toString("hex");
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
	what: string,
	seconds: number,
	probe: () => Promise<T | undefined>,
): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = String(error);
		}
		await sleep(3000);
	}
	throw new Error(
		`timed out after ${seconds}s waiting for ${what}${lastError ? ` (${lastError})` : ""}`,
	);
}

async function health(): Promise<Record<string, unknown>> {
	const res = await fetch(`https://${cfg.host}/api/health`, {
		signal: AbortSignal.timeout(10_000),
	});
	return (await res.json()) as Record<string, unknown>;
}

async function status() {
	const ids = await findProject();
	log(`dokploy ${cfg.url}  project ${cfg.project}`);
	if (ids.applicationId) {
		const app = await api<App>("application.one", {
			applicationId: ids.applicationId,
		});
		log(
			`  app      ${app.name}: ${app.applicationStatus}  env: ${[...parseEnv(app.env).keys()].join(", ") || "(none)"}`,
		);
	} else log(`  app      ${cfg.app}: MISSING`);
	if (ids.composeId) {
		const infra = await api<Compose>("compose.one", {
			composeId: ids.composeId,
		});
		const domains = await api<Domain[]>("domain.byComposeId", {
			composeId: ids.composeId,
		});
		log(
			`  infra    ${infra.name}: ${infra.composeStatus}  env: ${[...parseEnv(infra.env).keys()].join(", ") || "(none)"}`,
		);
		for (const d of domains)
			log(
				`  route    https://${d.host}${d.path ?? ""} → ${d.serviceName}:${d.port}`,
			);
	} else
		log(`  infra    ${cfg.infra}: MISSING (run: bun deploy/dokploy.ts apply)`);
	log(
		`  health   ${JSON.stringify(await health().catch((e) => ({ error: String(e) })))}`,
	);
}

async function apply() {
	const ids = await findProject();
	if (!ids.applicationId)
		throw new Error(`app '${cfg.app}' not found in project '${cfg.project}'`);

	// 1. The infra compose: source = this repo, so Dokploy always runs what is on main.
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
	const issuer = createAccount();
	const infraEnv = mergeEnv(parseEnv(infra.env), {
		keep: {
			DOLT_ROOT_PASSWORD: secret,
			NATS_AUTH_PASSWORD: secret,
			// The seed is kept next to the public key so the app env can be rebuilt from here.
			NATS_ISSUER_SEED: () => new TextDecoder().decode(issuer.getSeed()),
		},
	});
	const seed = infraEnv.env.get("NATS_ISSUER_SEED");
	if (!seed) throw new Error("NATS_ISSUER_SEED missing");
	const withPublic = mergeEnv(infraEnv.env, {
		set: {
			NATS_ISSUER_PUBLIC: fromSeed(
				new TextEncoder().encode(seed),
			).getPublicKey(),
		},
	});
	const infraChanged = [...infraEnv.changed, ...withPublic.changed];
	await api("compose.update", {
		composeId,
		sourceType: "git",
		customGitUrl: cfg.repo,
		customGitBranch: cfg.branch,
		composePath: cfg.composePath,
		autoDeploy: true,
		env: serializeEnv(withPublic.env),
	});
	log(
		`infra: source ${cfg.repo}@${cfg.branch} ${cfg.composePath}; env ${infraChanged.length ? `added ${infraChanged.join(", ")}` : "unchanged"}`,
	);

	// 2. The one public route: adapters reach NATS over WebSocket.
	const domains = await api<Domain[]>("domain.byComposeId", { composeId });
	if (!domains.some((d) => d.host === cfg.host && d.path === "/nats")) {
		await api("domain.create", {
			host: cfg.host,
			path: "/nats",
			port: 8080,
			https: true,
			certificateType: "none",
			composeId,
			serviceName: "nats",
			domainType: "compose",
		});
		log(`infra: route wss://${cfg.host}/nats → nats:8080`);
	}

	// 3. Deploy the stack and wait for Dokploy to finish.
	await api("compose.deploy", { composeId, title: "deploy/dokploy.ts apply" });
	await sleep(3000);
	await waitFor("the infra deploy", 600, async () => {
		const c = await api<Compose>("compose.one", { composeId });
		if (c.composeStatus === "error")
			throw new Error(
				"Dokploy reports the compose deploy failed; see its log in Dokploy",
			);
		return c.composeStatus === "done" ? true : undefined;
	}).catch((error) => {
		if (String(error).includes("failed")) process.exitCode = 1;
		throw error;
	});
	log("infra: deployed");

	// 4. Point the app at the stack. Existing keys (DATABASE_URL, ...) are left alone.
	const app = await api<App>("application.one", {
		applicationId: ids.applicationId,
	});
	const e: Env = withPublic.env;
	const appEnv = mergeEnv(parseEnv(app.env), {
		set: {
			DOLT_URL: `mysql://root:${e.get("DOLT_ROOT_PASSWORD")}@mastermind-dolt:3306/mastermind`,
			DOLT_BACKUP_URL: "file:///backups/mastermind",
			NATS_URL: "nats://mastermind-nats:4222",
			NATS_AUTH_USER: "mastermind",
			NATS_AUTH_PASSWORD: e.get("NATS_AUTH_PASSWORD") ?? "",
			NATS_ISSUER_SEED: seed,
			NATS_PUBLIC_WS_URL: `wss://${cfg.host}/nats`,
		},
	});
	if (appEnv.changed.length) {
		await api("application.saveEnvironment", {
			applicationId: ids.applicationId,
			env: serializeEnv(appEnv.env),
			buildArgs: app.buildArgs ?? "",
			buildSecrets: app.buildSecrets ?? "",
			createEnvFile: app.createEnvFile ?? false,
		});
		await api("application.deploy", {
			applicationId: ids.applicationId,
			title: "deploy/dokploy.ts apply (env)",
		});
		log(`app: env set ${appEnv.changed.join(", ")}; redeploying`);
	} else log("app: env unchanged");

	// 5. Verify from outside.
	const h = await waitFor("health dolt=up bd=up", 300, async () => {
		const now = await health();
		return now.dolt === "up" && now.bd === "up" ? now : undefined;
	});
	log(`ok: ${JSON.stringify(h)}`);
}

/** Put the two redeploy hooks into the GitHub environment. The URLs go through stdin, not argv. */
async function secrets() {
	const ids = await findProject();
	if (!ids.applicationId || !ids.composeId) throw new Error("run apply first");
	const app = await api<App>("application.one", {
		applicationId: ids.applicationId,
	});
	const infra = await api<Compose>("compose.one", { composeId: ids.composeId });
	const hooks = {
		DOKPLOY_DEPLOY_HOOK: `${cfg.url}/api/deploy/${app.refreshToken}`,
		DOKPLOY_INFRA_HOOK: `${cfg.url}/api/deploy/compose/${infra.refreshToken}`,
	};
	for (const [name, value] of Object.entries(hooks)) {
		const proc = Bun.spawn(
			["gh", "secret", "set", name, "--env", cfg.githubEnvironment],
			{
				stdin: new TextEncoder().encode(value),
				stdout: "ignore",
				stderr: "inherit",
			},
		);
		if ((await proc.exited) !== 0)
			throw new Error(`gh secret set ${name} failed`);
		log(`github: ${name} set on environment ${cfg.githubEnvironment}`);
	}
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
