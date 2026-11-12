/**
 * `onboard`, credentials part (mm-210.67). Two choices, each with a short
 * why, like `gh auth login`. Every value goes into the LOCAL secret store
 * (secrets/store.ts); Mastermind never receives one. A stored credential is
 * checked and kept: running onboard again asks nothing.
 *
 * Claude (the agent in the box):
 *   setup-token  `claude setup-token`: your own subscription; Anthropic
 *                documents it for scripts and CI. CLAUDE_CODE_OAUTH_TOKEN.
 *   api-key      an Anthropic API key: recommended for shared or team use
 *                (billed to the organization, one key per runner, revocable).
 *                ANTHROPIC_API_KEY.
 * Git (clone and push of the box output):
 *   app          a GitHub App made with the App Manifest flow (github.ts):
 *                a token per task for one repo, 1 h; nothing long-lived in
 *                the box. GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG.
 *   token        a fine-grained personal access token (exact permissions
 *                printed). GITHUB_TOKEN.
 *   skip         no git credential: public repos only, no push.
 */
import {
	appInstallations,
	checkApp,
	checkToken,
	exchangeCode,
	type Fetch,
	FINE_GRAINED_PERMISSIONS,
	FINE_GRAINED_URL,
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
	GITHUB_TOKEN,
	installUrl,
	newState,
	parseCode,
	serveManifest,
} from "./github.ts";
import {
	ANTHROPIC_KEYS_URL,
	boxModelSecret,
	checkModelSecret,
	type ModelCheck,
	modelCheckText,
	modelCredentialFix,
} from "./model-check.ts";
import { fail, pass, type StepResult } from "./onboard.ts";

export { ANTHROPIC_KEYS_URL };
export const CLAUDE_OAUTH = "CLAUDE_CODE_OAUTH_TOKEN";
export const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";
/** Git credential names the box output reads (box/output.ts), besides the app. */
const GIT_NAMES = ["GIT_TOKEN", GITHUB_TOKEN, "GH_TOKEN", "GIT_SSH_KEY"];

export const CLAUDE_CHOICES = ["setup-token", "api-key", "skip"] as const;
export const GIT_CHOICES = ["app", "token", "skip"] as const;
export type ClaudeChoice = (typeof CLAUDE_CHOICES)[number];
export type GitChoice = (typeof GIT_CHOICES)[number];

export type Choice = { key: string; label: string; why: string };

/** How onboard talks to the user. Not interactive: only flags and stdin. */
export type Prompt = {
	interactive: boolean;
	out: (line: string) => void;
	/** Pick one of the choices (interactive only). */
	choose: (question: string, choices: Choice[]) => Promise<string>;
	/** One visible line; the signal stops waiting. */
	line: (prompt: string, signal?: AbortSignal) => Promise<string>;
	/** A hidden value (or stdin when piped). */
	secret: (prompt: string) => Promise<string>;
	/** Open a URL in the browser (best effort). */
	open?: (url: string) => void;
};

export type Store = {
	load: () => Promise<Record<string, string>>;
	set: (name: string, value: string) => Promise<void>;
};

export type CredentialInput = {
	store: Store;
	prompt: Prompt;
	fetch?: Fetch;
};

const CLAUDE_MENU: Choice[] = [
	{
		key: "setup-token",
		label: "claude setup-token (your Claude subscription)",
		why: "uses your own plan; Anthropic documents it for scripts; good for one person",
	},
	{
		key: "api-key",
		label: "Anthropic API key",
		why: "recommended for shared or team use: billed to the organization, one key per runner, revocable",
	},
	{
		key: "skip",
		label: "skip",
		why: "the agent in the box has no Claude login",
	},
];

const GIT_MENU: Choice[] = [
	{
		key: "app",
		label: "GitHub App (made for you, one click)",
		why: "recommended: a token per task for one repo, valid 1 h; you choose the repos",
	},
	{
		key: "token",
		label: "fine-grained personal access token",
		why: "simple; one long-lived token for the repos you select",
	},
	{
		key: "skip",
		label: "skip",
		why: "public repos only; the box cannot push a branch or open a pull request",
	},
];

/** The Claude credential: kept when stored, else asked for (or the flag). */
export async function claudeCredential(
	i: CredentialInput & { choice?: string },
): Promise<StepResult> {
	const f = i.fetch ?? fetch;
	const stored = boxModelSecret(await i.store.load());
	if (stored && !i.choice) {
		// A stored credential is checked too (mm-210.80): the box uses it as is.
		const c = await checkModelSecret(stored.secret, stored.value, f);
		if (c.result === "refused")
			return fail(
				`Anthropic refuses the stored ${stored.secret}: ${modelCheckText(c)}`,
				`${modelCredentialFix(stored.secret)} (or: onboard --claude ${stored.secret === CLAUDE_OAUTH ? "setup-token" : "api-key"})`,
			);
		return pass(`${stored.secret} stored on this machine${checked(c)}`);
	}
	const choice = await pick(
		i.prompt,
		i.choice,
		CLAUDE_MENU,
		"--claude",
		"Claude login for the agent in the box",
	);
	if ("problem" in choice) return fail(choice.problem, choice.fix);
	const p = i.prompt;
	if (choice.key === "skip")
		return pass("skipped (the agent in the box has no Claude login)");
	if (choice.key === "setup-token") {
		p.out("  Run in another terminal: claude setup-token");
		p.out(
			"  It opens the browser and prints a token that starts with sk-ant-oat.",
		);
		const v = (await p.secret("  token (hidden): ")).trim();
		if (!v)
			return fail(
				"no token",
				`run claude setup-token, then onboard again (or: mastermind-runner secrets set ${CLAUDE_OAUTH})`,
			);
		if (!v.startsWith("sk-ant-oat"))
			return fail(
				"this is not a token from claude setup-token (it starts with sk-ant-oat)",
				`an API key is --claude api-key; else run claude setup-token again`,
			);
		const c = await checkModelSecret(CLAUDE_OAUTH, v, f);
		if (c.result === "refused")
			return fail(
				`Anthropic refuses this token: ${modelCheckText(c)}`,
				modelCredentialFix(CLAUDE_OAUTH),
			);
		await i.store.set(CLAUDE_OAUTH, v);
		return pass(`${CLAUDE_OAUTH} stored on this machine${checked(c)}`);
	}
	p.out(
		`  Make a key: ${ANTHROPIC_KEYS_URL} (one key per runner: you can revoke it alone)`,
	);
	const v = (await p.secret("  API key (hidden): ")).trim();
	if (!v)
		return fail(
			"no API key",
			`make one at ${ANTHROPIC_KEYS_URL}, then onboard again (or: mastermind-runner secrets set ${ANTHROPIC_KEY})`,
		);
	const c = await checkModelSecret(ANTHROPIC_KEY, v, f);
	if (c.result === "refused")
		return fail(
			`Anthropic refuses this API key: ${modelCheckText(c)}`,
			`check the key at ${ANTHROPIC_KEYS_URL}, then onboard again`,
		);
	await i.store.set(ANTHROPIC_KEY, v);
	return pass(`${ANTHROPIC_KEY} stored on this machine${checked(c)}`);
}

/** The result of the Anthropic check, after 'stored on this machine'. Never the value. */
function checked(c: ModelCheck): string {
	if (c.result === "accepted") return ", accepted by Anthropic";
	return ` (not checked with Anthropic: ${c.result === "unchecked" ? c.why : modelCheckText(c)})`;
}

export type GitInput = CredentialInput & {
	choice?: string;
	/** GitHub App name (max 34 characters on GitHub). */
	appName: string;
	/** Make the app in this organization (default: the user's account). */
	org?: string;
	/** An app made before: its id and key file (scripts). */
	appId?: string;
	appKey?: string;
	/** Fixed loopback port (tests; ssh -L). */
	port?: number;
};

/** The git credential: a stored one is checked; else the GitHub App, a token, or skip. */
export async function gitCredential(i: GitInput): Promise<StepResult> {
	const f = i.fetch ?? fetch;
	const stored = await i.store.load();
	if (!i.choice || i.choice === "app") {
		const id = i.appId ?? stored[GITHUB_APP_ID];
		const pem = i.appKey ?? stored[GITHUB_APP_PRIVATE_KEY];
		if (id && pem) return keepApp(i, id, pem, f);
	}
	if (!i.choice) {
		const have = GIT_NAMES.find((n) => stored[n]);
		if (have) return pass(`${have} stored on this machine`);
	}
	const choice = await pick(
		i.prompt,
		i.choice,
		GIT_MENU,
		"--git",
		"git credential for clone and push",
	);
	if ("problem" in choice) return fail(choice.problem, choice.fix);
	const p = i.prompt;
	if (choice.key === "skip")
		return pass("skipped (public repos only; no push, no pull request)");
	if (choice.key === "token") {
		p.out(`  Make a token: ${FINE_GRAINED_URL}`);
		for (const l of FINE_GRAINED_PERMISSIONS) p.out(`    - ${l}`);
		const v = (await p.secret("  token (hidden): ")).trim();
		if (!v)
			return fail(
				"no token",
				`make one at ${FINE_GRAINED_URL}, then onboard again (or: mastermind-runner secrets set ${GITHUB_TOKEN})`,
			);
		try {
			const who = await checkToken(v, f);
			await i.store.set(GITHUB_TOKEN, v);
			return pass(
				`${GITHUB_TOKEN} stored on this machine (GitHub user ${who.login})`,
			);
		} catch (error) {
			return fail(msg(error), `make a new token at ${FINE_GRAINED_URL}`);
		}
	}
	// The GitHub App, made from the manifest.
	if (!p.interactive)
		return fail(
			"the GitHub App is made in a browser",
			"run onboard once in a terminal (--git app), or pass --github-app-id <id> --github-app-key <file.pem> of an app you made",
		);
	const state = newState();
	const s = serveManifest({
		name: i.appName,
		state,
		...(i.org ? { org: i.org } : {}),
		...(i.port ? { port: i.port } : {}),
	});
	let code: string;
	try {
		p.out(`  Open ${s.url} in a browser on this machine.`);
		p.out(
			`  It sends the app "${i.appName}" (Contents and Pull requests: write; Metadata: read; no webhook) to GitHub${i.org ? ` for the organization ${i.org}` : ""}.`,
		);
		p.out(
			"  On GitHub click Create GitHub App; GitHub then sends the browser back here.",
		);
		p.out(
			`  Browser on another machine: ssh -L ${new URL(s.url).port}:127.0.0.1:${new URL(s.url).port} <this machine>, or paste the address of the page GitHub sends you to.`,
		);
		p.open?.(s.url);
		const stop = new AbortController();
		const pasted = (async () => {
			for (;;) {
				const l = await p.line(
					"  pasted address or code (or wait): ",
					stop.signal,
				);
				const c = parseCode(l, state);
				if ("code" in c) return c.code;
				p.out(`  ${c.error}; try again`);
			}
		})();
		code = await Promise.race([s.code, pasted]);
		stop.abort();
		pasted.catch(() => {});
	} finally {
		s.stop();
	}
	let app: Awaited<ReturnType<typeof exchangeCode>>;
	try {
		app = await exchangeCode(code, f);
	} catch (error) {
		return fail(msg(error), "run onboard again: it makes a new code");
	}
	await i.store.set(GITHUB_APP_ID, String(app.id));
	await i.store.set(GITHUB_APP_PRIVATE_KEY, app.pem);
	if (app.slug) await i.store.set(GITHUB_APP_SLUG, app.slug);
	p.out(`  App ${app.slug} (id ${app.id}) stored on this machine.`);
	const install = installUrl(app.slug);
	p.out(`  Install it on the repos of your environments: ${install}`);
	p.open?.(install);
	await p.line("  press Enter when it is installed: ");
	return keepApp(i, String(app.id), app.pem, f);
}

/** A stored (or given) app: GitHub accepts it and it is installed somewhere. */
async function keepApp(
	i: GitInput,
	id: string,
	pem: string,
	f: Fetch,
): Promise<StepResult> {
	let slug: string;
	try {
		slug = (await checkApp(id, pem, f)).slug;
	} catch (error) {
		return fail(
			msg(error),
			`check ${GITHUB_APP_ID} and ${GITHUB_APP_PRIVATE_KEY} (mastermind-runner secrets set ...), or make a new app: onboard --git app`,
		);
	}
	const stored = await i.store.load();
	if (stored[GITHUB_APP_ID] !== id) await i.store.set(GITHUB_APP_ID, id);
	if (stored[GITHUB_APP_PRIVATE_KEY] !== pem)
		await i.store.set(GITHUB_APP_PRIVATE_KEY, pem);
	if (slug && stored[GITHUB_APP_SLUG] !== slug)
		await i.store.set(GITHUB_APP_SLUG, slug);
	let where: string[];
	try {
		where = await appInstallations(id, pem, f);
	} catch (error) {
		return fail(
			msg(error),
			"check the network to api.github.com, then onboard again",
		);
	}
	if (!where.length)
		return fail(
			`the GitHub App ${slug} is not installed on any repo`,
			`install it: ${installUrl(slug)}, then onboard again`,
		);
	return pass(
		`GitHub App ${slug}, installed on ${where.join(", ")} (tokens per task, 1 h)`,
	);
}

/** The flag's choice, or the menu (interactive), or the fix for scripts. */
async function pick(
	p: Prompt,
	given: string | undefined,
	menu: Choice[],
	flag: string,
	what: string,
): Promise<Choice | { problem: string; fix: string }> {
	const keys = menu.map((m) => m.key);
	if (given) {
		const c = menu.find((m) => m.key === given);
		return (
			c ?? {
				problem: `${flag} ${given} is not one of ${keys.join(", ")}`,
				fix: `${flag} ${keys.join("|")}`,
			}
		);
	}
	if (!p.interactive)
		return {
			problem: `no ${what} stored, and no ${flag}`,
			fix: `pass ${flag} ${keys.join("|")} (the value comes from stdin)`,
		};
	const k = await p.choose(`${what}:`, menu);
	return (
		menu.find((m) => m.key === k) ?? {
			problem: `no choice for the ${what}`,
			fix: `run onboard again, or pass ${flag} ${keys.join("|")}`,
		}
	);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The default GitHub App name: `mm-<account>-<runner>`, at most 34 characters. */
export function defaultAppName(account: string, runner: string): string {
	return `mm-${account}-${runner}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.slice(0, 34)
		.replace(/-+$/, "");
}
