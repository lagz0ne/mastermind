/**
 * mm-210.51 acceptance: an environment needs GITHUB_TOKEN and
 * CLAUDE_CODE_OAUTH_TOKEN. `secrets list` shows both needed and missing;
 * `secrets check` and doctor fail with the fix lines; a dispatch is declined
 * with 'missing secrets'; after `secrets set` both are present, and the
 * values appear in no output, report or diagnostics.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDispatch } from "../src/check.ts";
import { EXIT, main } from "../src/cli.ts";
import {
	defaultSettings,
	type RunnerConfig,
	saveConfig,
} from "../src/config.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { formatReport, runDoctor } from "../src/doctor.ts";
import { implicitRouting } from "../src/routing.ts";
import {
	fetchNeeds,
	lookupSecret,
	neededSecrets,
} from "../src/secrets/needs.ts";
import { secretsState } from "../src/secrets/state.ts";
import { SecretStore } from "../src/secrets/store.ts";
import { dispatch } from "./fakes.ts";

const dir = mkdtempSync(join(tmpdir(), "mm-runner-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GH = "ghp_SUPERSECRETvalue123";
const CLAUDE = "sk-ant-oat-VERYsecret456";
const ENVS = {
	environments: [
		{ name: "web", secrets: ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] },
		{ name: "docs", secrets: ["DOCS_KEY"] },
	],
};

let calls = 0;
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
	calls++;
	expect(String(url)).toBe("https://mm.example/api/runner/environments");
	const auth = new Headers(init?.headers).get("authorization");
	if (auth !== "Bearer mms_alice_1_cred")
		return new Response("{}", { status: 401 });
	return Response.json(ENVS);
}) as typeof fetch;

const cfgPath = join(dir, "c", "runner.json");
const cfg: RunnerConfig = {
	version: 1,
	mastermindUrl: "https://mm.example",
	natsUrl: "wss://nats.example",
	account: "alice",
	serviceAccount: { id: "1", name: "laptop" },
	credential: "mms_alice_1_cred",
	inboxPrefix: "_INBOX.alice",
	state: "active",
	enrolledAt: "2026-11-11T00:00:00Z",
	runner: { ...defaultSettings("laptop"), queues: ["backend"], workdir: dir },
};
// routing.json binds only "web": "docs" is never offered to this runner.
writeFileSync(
	join(dir, "c", "..", "routing.json"),
	JSON.stringify({
		targets: { default: {} },
		environments: { web: { dir } },
		rules: [{ match: {}, target: "default" }],
	}),
);

function io(input = "") {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		all: () => [...out, ...err].join("\n"),
		io: {
			env: {
				MASTERMIND_RUNNER_CONFIG: cfgPath,
				MASTERMIND_RUNNER_ROUTING: join(dir, "routing.json"),
			} as Record<string, string | undefined>,
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
			cwd: dir,
			fetch: fakeFetch,
			readSecret: async () => input,
		},
	};
}

describe("secrets end to end (names only)", () => {
	test("list: both needed and missing; only bound environments count", async () => {
		await saveConfig(cfgPath, cfg);
		const t = io();
		expect(await main(["secrets", "list"], t.io)).toBe(EXIT.ok);
		const text = t.out.join("\n");
		expect(text).toMatch(/GITHUB_TOKEN\s+web\s+NO/);
		expect(text).toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s+web\s+NO/);
		expect(text).not.toContain("DOCS_KEY");
		expect(text).toContain("fix: mastermind-runner secrets set GITHUB_TOKEN");
	});

	test("check fails with the fix lines", async () => {
		const t = io();
		expect(await main(["secrets", "check"], t.io)).toBe(EXIT.error);
		expect(t.out).toContain(
			"fix: mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN",
		);
	});

	test("doctor step f fails with the fix line", async () => {
		const routing = {
			...implicitRouting(cfg.runner),
			implicit: false,
			environments: { web: { dir } },
		};
		const report = await runDoctor(
			{
				config: null,
				configPath: cfgPath,
				settings: cfg.runner,
				routing,
				routingSource: "test",
				version: "dev",
				deep: false,
				secrets: () =>
					secretsState({
						file: join(dir, "c", "secrets"),
						mastermindUrl: cfg.mastermindUrl,
						credential: cfg.credential,
						routing,
						env: {},
						fetch: fakeFetch,
					}),
			},
			{
				fetch: fakeFetch,
				paseo: async () => {
					throw new Error("no paseo");
				},
				isGitDir: async () => true,
			},
		);
		const f = report.steps.find((s) => s.id === "f");
		expect(f?.status).toBe("fail");
		expect(f?.fix).toBe(
			"mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN",
		);
		expect(formatReport(report).join("\n")).toContain(
			"GITHUB_TOKEN: MISSING, needed by web; fix: mastermind-runner secrets set GITHUB_TOKEN",
		);
	});

	test("a dispatch that needs them is declined with 'missing secrets'", async () => {
		const r = await checkDispatch(
			dispatch("a", {
				env: {
					name: "web",
					repo: "",
					ref: "",
					requires: [],
					secrets: ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
				},
			}),
			cfg.runner,
			{ binding: { name: "web", dir } },
			{ env: {}, secrets: new SecretStore(join(dir, "c", "secrets")) },
		);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toStartWith(
			"missing secrets: GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN",
		);
	});

	test("set takes no value from argv", async () => {
		const t = io(GH);
		expect(await main(["secrets", "set", "GITHUB_TOKEN", GH], t.io)).toBe(
			EXIT.usage,
		);
		expect(t.err[0]).toContain("never taken from the command line");
		expect(t.all()).not.toContain(GH);
	});

	test("after set both are present; the values are in no output", async () => {
		const outputs: string[] = [];
		for (const [name, value] of [
			["GITHUB_TOKEN", GH],
			["CLAUDE_CODE_OAUTH_TOKEN", CLAUDE],
		] as const) {
			const t = io(value);
			expect(await main(["secrets", "set", name], t.io)).toBe(EXIT.ok);
			outputs.push(t.all());
		}
		const file = join(dir, "c", "secrets");
		expect(statSync(file).mode & 0o777).toBe(0o600);

		const list = io();
		expect(await main(["secrets", "list"], list.io)).toBe(EXIT.ok);
		expect(list.out.join("\n")).toMatch(/GITHUB_TOKEN\s+web\s+yes \(store\)/);
		const json = io();
		expect(await main(["secrets", "list", "--json"], json.io)).toBe(EXIT.ok);
		expect(JSON.parse(json.out.join("\n")).missing).toEqual([]);
		const check = io();
		expect(await main(["secrets", "check"], check.io)).toBe(EXIT.ok);
		outputs.push(list.all(), json.all(), check.all());

		// The agent gets the values; diagnostics and the decline path do not.
		const r = await checkDispatch(
			dispatch("a", {
				env: {
					name: "web",
					repo: "",
					ref: "",
					requires: [],
					secrets: ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
				},
			}),
			cfg.runner,
			{ binding: { name: "web", dir } },
			{ env: {}, secrets: new SecretStore(file) },
		);
		expect(r.ok && r.env).toEqual({
			GITHUB_TOKEN: GH,
			CLAUDE_CODE_OAUTH_TOKEN: CLAUDE,
		});
		const state = await secretsState({
			file,
			mastermindUrl: cfg.mastermindUrl,
			credential: cfg.credential,
			routing: { environments: { web: { dir } } },
			env: {},
			fetch: fakeFetch,
		});
		const diag = new Diagnostics(cfg.runner, "dev");
		diag.secrets = state.diagnostics;
		diag.log(`error: something with ${state.diagnostics.needed.join(",")}`);
		outputs.push(JSON.stringify(diag.snapshot()), JSON.stringify(state.rows));
		expect(diag.snapshot().secrets).toEqual({
			needed: ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"],
			missing: [],
			needsAt: state.needs?.at ?? null,
		});

		const all = outputs.join("\n");
		expect(all).not.toContain(GH);
		expect(all).not.toContain(CLAUDE);
	});

	test("unset removes a value", async () => {
		const t = io();
		expect(await main(["secrets", "unset", "GITHUB_TOKEN"], t.io)).toBe(
			EXIT.ok,
		);
		expect(await new SecretStore(join(dir, "c", "secrets")).names()).toEqual([
			"CLAUDE_CODE_OAUTH_TOKEN",
		]);
	});

	test("offline: the cached names are used, with a note", async () => {
		const before = calls;
		const routing = { environments: { web: { dir } } };
		const s = await secretsState({
			file: join(dir, "c", "secrets"),
			mastermindUrl: cfg.mastermindUrl,
			credential: cfg.credential,
			routing,
			env: {},
			fetch: (async () => {
				throw new Error("offline");
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(before);
		expect(s.diagnostics.missing).toEqual(["GITHUB_TOKEN"]);
		expect(s.problem).toContain("using the needed names from");
	});
});

describe("store and lookup", () => {
	test("a store readable by others is refused", async () => {
		const f = join(dir, "loose");
		writeFileSync(f, "{}", { mode: 0o644 });
		await expect(new SecretStore(f).load()).rejects.toThrow("chmod 600");
	});
	test("bad names are refused", async () => {
		await expect(
			new SecretStore(join(dir, "s2")).set("A B", "x"),
		).rejects.toThrow("bad secret name");
	});
	test("routing.json source wins, then the store, then the env var", async () => {
		const l = { store: { A: "s" }, env: { A: "e", B: "e", V: "v" } };
		expect(await lookupSecret("A", l)).toEqual({ value: "s", from: "store" });
		expect(await lookupSecret("B", l)).toEqual({ value: "e", from: "env:B" });
		expect(await lookupSecret("A", { ...l, binding: { A: "env:V" } })).toEqual({
			value: "v",
			from: "env:V",
		});
		expect(await lookupSecret("C", l)).toBeNull();
	});
	test("needed: all environments unless routing binds some", async () => {
		const needs = { at: "", environments: ENVS.environments };
		expect([
			...neededSecrets(needs, { environments: {}, implicit: true }).keys(),
		]).toEqual(["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "DOCS_KEY"]);
		expect([
			...neededSecrets(needs, { environments: { docs: { dir } } }).keys(),
		]).toEqual(["DOCS_KEY"]);
	});
	test("fetchNeeds: 401 and 404 have clear messages", async () => {
		const f = (status: number) =>
			(async () => new Response("{}", { status })) as unknown as typeof fetch;
		await expect(
			fetchNeeds("https://x", "c", { fetch: f(401) }),
		).rejects.toThrow("refuses");
		await expect(
			fetchNeeds("https://x", "c", { fetch: f(404) }),
		).rejects.toThrow("does not serve");
	});
});
