// The site config: every value that belongs to one deployment and not to the code.

export type Site = {
	/** Base URL of the Dokploy that runs this site. */
	dokployUrl: string;
	/** Public base URL of the app, for example https://mastermind.example.com. */
	publicUrl: string;
	/** Dokploy project that holds everything. It must exist. */
	project: string;
	/** Name of the app (the UI + API image) in that project. It must exist. */
	app: string;
	/** Name of the compose service that runs deploy/compose.yml. */
	infra: string;
	/** Name of the application built from deploy/nats. */
	nats: string;
	/** Git URL and branch that Dokploy builds the infra from. */
	repo: string;
	branch: string;
	/** GitHub environment that receives the redeploy hooks. */
	githubEnvironment: string;
	/** More app env for this site, for example the OTLP endpoint. Never secrets. */
	appEnv: Record<string, string>;
};

const required = [
	"dokployUrl",
	"publicUrl",
	"project",
	"app",
	"infra",
	"nats",
	"repo",
	"branch",
	"githubEnvironment",
] as const;

export function parseSite(text: string, source: string): Site {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`${source} is not valid JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
	for (const key of required) {
		if (typeof raw[key] !== "string" || !raw[key])
			throw new Error(`${source}: "${key}" is missing (a non-empty string)`);
	}
	const appEnv = (raw.appEnv ?? {}) as Record<string, unknown>;
	for (const [key, value] of Object.entries(appEnv)) {
		if (typeof value !== "string")
			throw new Error(`${source}: appEnv.${key} must be a string`);
	}
	const site = raw as unknown as Site;
	return {
		...site,
		dokployUrl: site.dokployUrl.replace(/\/$/, ""),
		publicUrl: site.publicUrl.replace(/\/$/, ""),
		appEnv: appEnv as Record<string, string>,
	};
}

export async function loadSite(path: string): Promise<Site> {
	const file = Bun.file(path);
	if (!(await file.exists()))
		throw new Error(
			`site config not found: ${path} (set MASTERMIND_SITE to your site file)`,
		);
	return parseSite(await file.text(), path);
}
