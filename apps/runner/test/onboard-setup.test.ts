/**
 * onboard self-service (mm-210.67): the box engine is found by itself, or the
 * fix for this machine is named; the credentials are chosen, checked and
 * stored only on this machine; a second run asks nothing.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { DockerEndpoint } from "../src/box/docker.ts";
import {
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
} from "../src/github.ts";
import {
	type EngineDeps,
	findEngine,
	gvisorLine,
	installLink,
	usableRuntimes,
} from "../src/onboard-box.ts";
import {
	ANTHROPIC_KEY,
	CLAUDE_OAUTH,
	claudeCredential,
	defaultAppName,
	gitCredential,
	type Prompt,
	type Store,
} from "../src/onboard-credentials.ts";

const XDG = "/run/user/1000";

function engine(
	answers: Record<string, unknown>,
	o: Partial<EngineDeps> & { files?: string[]; bins?: string[] } = {},
): EngineDeps {
	const files = new Set(o.files ?? []);
	const bins = new Set(o.bins ?? []);
	return {
		env: { HOME: "/home/u", XDG_RUNTIME_DIR: XDG, ...o.env },
		platform: o.platform ?? "linux",
		uid: 1000,
		exists: (p) => files.has(p),
		which: (c) => (bins.has(c) ? `/usr/bin/${c}` : null),
		osRelease:
			o.osRelease ?? (() => 'ID="rocky"\nID_LIKE="rhel centos fedora"\n'),
		get: async (ep: DockerEndpoint, path: string) => {
			const a = answers[`${ep.unix ?? ep.base} ${path}`];
			if (a instanceof Error) throw a;
			if (a === undefined) throw new Error("connect ENOENT");
			return { status: 200, body: a };
		},
	};
}

describe("box engine", () => {
	test("Docker at the default socket: no DOCKER_HOST needed; gVisor listed", async () => {
		const r = await findEngine(
			engine(
				{
					"/var/run/docker.sock /version": { Version: "27.1" },
					"/var/run/docker.sock /info": {
						Runtimes: {
							runc: { path: "runc" },
							runsc: { path: "/usr/local/bin/runsc" },
						},
					},
				},
				{
					files: ["/var/run/docker.sock", "/usr/local/bin/runsc"],
					bins: ["runc"],
				},
			),
		);
		expect(r).toMatchObject({
			ok: true,
			version: "Docker 27.1",
			podman: false,
			runtimes: ["runc", "runsc"],
		});
		expect("exportLine" in r).toBe(false);
		if (r.ok) expect(gvisorLine(r.runtimes)).toBe("gVisor (runsc) available");
	});

	test("rootless Podman: found by itself; runsc from containers.conf without a binary does not count", async () => {
		const sock = `${XDG}/podman/podman.sock`;
		const r = await findEngine(
			engine(
				{
					[`${sock} /version`]: {
						Version: "5.2",
						Components: [{ Name: "Podman Engine" }],
					},
					[`${sock} /info`]: {
						Runtimes: {
							crun: { path: "/usr/bin/crun" },
							runsc: { path: "/usr/bin/runsc" },
						},
					},
				},
				{ files: [sock, "/usr/bin/crun"] },
			),
		);
		expect(r).toMatchObject({ ok: true, podman: true, runtimes: ["crun"] });
		if (r.ok)
			expect(gvisorLine(r.runtimes)).toContain("not installed (optional");
	});

	test("Docker Desktop socket: used, and the DOCKER_HOST line for start", async () => {
		const sock = "/home/u/.docker/run/docker.sock";
		const r = await findEngine(
			engine(
				{ [`${sock} /version`]: { Version: "27" } },
				{ files: [sock], platform: "darwin" },
			),
		);
		expect(r).toMatchObject({
			ok: true,
			exportLine: `export DOCKER_HOST=unix://${sock}`,
		});
		if (r.ok) expect(r.env.DOCKER_HOST).toBe(`unix://${sock}`);
	});

	test("no engine: the install link for this distro", async () => {
		const r = await findEngine(engine({}));
		expect(r).toMatchObject({
			ok: false,
			problem: "no box engine on this machine (no Docker, no Podman)",
		});
		if (!r.ok) {
			expect(r.fix).toContain("https://docs.docker.com/engine/install/rhel/");
			expect(r.fix).toContain("https://podman.io/docs/installation");
		}
		expect(installLink("linux", "ID=ubuntu\n").docker).toBe(
			"https://docs.docker.com/engine/install/ubuntu/",
		);
		expect(installLink("darwin").docker).toContain("mac-install");
		expect(installLink("linux", "ID=arch\n").docker).toBe(
			"https://docs.docker.com/engine/install/",
		);
	});

	test("socket without permission: the docker group fix", async () => {
		const r = await findEngine(
			engine(
				{
					"/var/run/docker.sock /version": new Error(
						"EACCES: permission denied",
					),
				},
				{ files: ["/var/run/docker.sock"] },
			),
		);
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.fix).toContain("usermod -aG docker");
	});

	test("Podman installed, socket off: enable the user socket", async () => {
		const r = await findEngine(engine({}, { bins: ["podman"] }));
		if (r.ok) throw new Error("expected a failure");
		expect(r.fix).toContain("systemctl --user enable --now podman.socket");
	});

	test("DOCKER_HOST is used alone", async () => {
		const r = await findEngine(
			engine(
				{},
				{
					env: { DOCKER_HOST: "unix:///x.sock" },
					files: ["/var/run/docker.sock"],
				},
			),
		);
		expect(r).toMatchObject({ ok: false });
		if (!r.ok)
			expect(r.problem).toContain("DOCKER_HOST=unix:///x.sock does not answer");
	});

	test("remote engine: runtimes as listed", () => {
		expect(
			usableRuntimes(
				{ Runtimes: { runsc: {} } },
				false,
				() => false,
				() => null,
			),
		).toEqual(["runsc"]);
	});
});

function memStore(
	init: Record<string, string> = {},
): Store & { v: Record<string, string> } {
	const v = { ...init };
	return {
		v,
		load: async () => ({ ...v }),
		set: async (k, x) => {
			v[k] = x;
		},
	};
}

function prompt(
	o: {
		interactive?: boolean;
		choose?: string[];
		secrets?: string[];
		lines?: string[];
	} = {},
) {
	const out: string[] = [];
	const asked: string[] = [];
	const opened: string[] = [];
	const p: Prompt = {
		interactive: o.interactive ?? true,
		out: (l) => out.push(l),
		choose: async (q) => {
			asked.push(q);
			return o.choose?.shift() ?? "";
		},
		line: async (q, signal) => {
			asked.push(q);
			const l = o.lines?.shift();
			if (l !== undefined) return l;
			return new Promise((_, rej) =>
				signal?.addEventListener("abort", () => rej(new Error("aborted"))),
			);
		},
		secret: async (q) => {
			asked.push(q);
			return o.secrets?.shift() ?? "";
		},
		open: (u) => opened.push(u),
	};
	return { p, out, asked, opened };
}

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

function github(installed: string[] = ["duke"]) {
	const calls: string[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(input));
		const key = `${init?.method ?? "GET"} ${u.host}${u.pathname}`;
		calls.push(key);
		if (key === "POST api.github.com/app-manifests/c0de/conversions")
			return Response.json({
				id: 99,
				slug: "mm-acme-laptop",
				pem: privateKey,
				owner: { login: "duke" },
			});
		if (key === "GET api.github.com/app")
			return Response.json({ slug: "mm-acme-laptop" });
		if (key === "GET api.github.com/app/installations")
			return Response.json(installed.map((login) => ({ account: { login } })));
		if (key === "GET api.github.com/user") {
			const ok =
				new Headers(init?.headers).get("authorization") ===
				"Bearer github_pat_ok";
			return ok
				? Response.json({ login: "duke" })
				: new Response("{}", { status: 401 });
		}
		if (key === "GET api.anthropic.com/v1/models") {
			const ok =
				new Headers(init?.headers).get("x-api-key") === "sk-ant-api-ok";
			return ok
				? Response.json({ data: [] })
				: new Response("{}", { status: 401 });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	return { f, calls };
}

describe("Claude credential", () => {
	test("stored: kept, nothing asked", async () => {
		const pr = prompt();
		const r = await claudeCredential({
			store: memStore({ [CLAUDE_OAUTH]: "sk-ant-oat-x" }),
			prompt: pr.p,
		});
		expect(r).toEqual({
			ok: true,
			detail: `${CLAUDE_OAUTH} stored on this machine`,
		});
		expect(pr.asked).toEqual([]);
	});

	test("setup-token from the menu: stored locally", async () => {
		const s = memStore();
		const pr = prompt({
			choose: ["setup-token"],
			secrets: ["sk-ant-oat01-abc"],
		});
		const r = await claudeCredential({ store: s, prompt: pr.p });
		expect(r.ok).toBe(true);
		expect(s.v[CLAUDE_OAUTH]).toBe("sk-ant-oat01-abc");
		expect(pr.out.join("\n")).toContain("claude setup-token");
		expect(pr.out.join("\n")).not.toContain("sk-ant-oat01-abc");
	});

	test("api key: checked with Anthropic; a refused key is not stored", async () => {
		const gh = github();
		const s = memStore();
		const bad = await claudeCredential({
			store: s,
			prompt: prompt({ secrets: ["sk-ant-api-bad"] }).p,
			choice: "api-key",
			fetch: gh.f,
		});
		expect(bad).toMatchObject({
			ok: false,
			problem: "Anthropic refuses this API key",
		});
		expect(s.v[ANTHROPIC_KEY]).toBeUndefined();
		const ok = await claudeCredential({
			store: s,
			prompt: prompt({ secrets: ["sk-ant-api-ok"] }).p,
			choice: "api-key",
			fetch: gh.f,
		});
		expect(ok.ok).toBe(true);
		expect(s.v[ANTHROPIC_KEY]).toBe("sk-ant-api-ok");
	});

	test("not interactive and no flag: the flag to pass", async () => {
		const r = await claudeCredential({
			store: memStore(),
			prompt: prompt({ interactive: false }).p,
		});
		expect(r).toMatchObject({
			ok: false,
			fix: "pass --claude setup-token|api-key|skip (the value comes from stdin)",
		});
	});
});

describe("git credential", () => {
	test("GitHub App from the manifest: callback code, exchange, stored locally, install link", async () => {
		const s = memStore();
		const gh = github();
		const pr = prompt({ choose: ["app"] });
		// The browser: open the loopback page, then GitHub's redirect to /callback.
		pr.p.open = (url) => {
			pr.opened.push(url);
			if (url.startsWith("http://127.0.0.1"))
				void (async () => {
					const page = await (await fetch(url)).text();
					const state = page.match(/state=([0-9a-f]+)/)?.[1];
					await fetch(`${url}callback?code=c0de&state=${state}`);
				})();
		};
		pr.p.line = async (q, signal) => {
			pr.asked.push(q);
			if (q.includes("press Enter")) return "";
			return new Promise((_, rej) =>
				signal?.addEventListener("abort", () => rej(new Error("aborted"))),
			);
		};
		const r = await gitCredential({
			store: s,
			prompt: pr.p,
			appName: "mm-acme-laptop",
			fetch: gh.f,
		});
		expect(r).toEqual({
			ok: true,
			detail:
				"GitHub App mm-acme-laptop, installed on duke (tokens per task, 1 h)",
		});
		expect(s.v[GITHUB_APP_ID]).toBe("99");
		expect(s.v[GITHUB_APP_PRIVATE_KEY]).toBe(privateKey);
		expect(s.v[GITHUB_APP_SLUG]).toBe("mm-acme-laptop");
		expect(pr.opened[1]).toBe(
			"https://github.com/apps/mm-acme-laptop/installations/new",
		);
		expect(pr.out.join("\n")).not.toContain("BEGIN RSA");
	});

	test("GitHub App: a pasted redirect address works too", async () => {
		const s = memStore();
		const gh = github();
		let pasted = false;
		const pr = prompt({ choose: ["app"] });
		pr.p.open = undefined;
		pr.p.line = async (q) => {
			if (q.includes("press Enter")) return "";
			if (pasted) return new Promise(() => {});
			pasted = true;
			return "https://example.com/callback?code=c0de";
		};
		const r = await gitCredential({
			store: s,
			prompt: pr.p,
			appName: "x",
			fetch: gh.f,
		});
		expect(r.ok).toBe(true);
		expect(s.v[GITHUB_APP_ID]).toBe("99");
	});

	test("stored app not installed: fails with the install link; second run after install passes and asks nothing", async () => {
		const s = memStore({
			[GITHUB_APP_ID]: "99",
			[GITHUB_APP_PRIVATE_KEY]: privateKey,
		});
		const pr = prompt();
		const r = await gitCredential({
			store: s,
			prompt: pr.p,
			appName: "x",
			fetch: github([]).f,
		});
		expect(r).toMatchObject({
			ok: false,
			fix: "install it: https://github.com/apps/mm-acme-laptop/installations/new, then onboard again",
		});
		const again = await gitCredential({
			store: s,
			prompt: pr.p,
			appName: "x",
			fetch: github().f,
		});
		expect(again.ok).toBe(true);
		expect(pr.asked).toEqual([]);
	});

	test("not interactive: the app needs a browser, or an existing app's id and key", async () => {
		const s = memStore();
		const r = await gitCredential({
			store: s,
			prompt: prompt({ interactive: false }).p,
			appName: "x",
			choice: "app",
		});
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.fix).toContain("--github-app-id");
		const given = await gitCredential({
			store: s,
			prompt: prompt({ interactive: false }).p,
			appName: "x",
			choice: "app",
			appId: "99",
			appKey: privateKey,
			fetch: github().f,
		});
		expect(given.ok).toBe(true);
		expect(s.v[GITHUB_APP_ID]).toBe("99");
	});

	test("fine-grained token: the permission list, checked, stored as GITHUB_TOKEN", async () => {
		const s = memStore();
		const pr = prompt({ secrets: ["github_pat_ok"] });
		const r = await gitCredential({
			store: s,
			prompt: pr.p,
			appName: "x",
			choice: "token",
			fetch: github().f,
		});
		expect(r).toEqual({
			ok: true,
			detail: "GITHUB_TOKEN stored on this machine (GitHub user duke)",
		});
		expect(pr.out.join("\n")).toContain("Contents: Read and write");
		expect(pr.out.join("\n")).toContain(
			"https://github.com/settings/personal-access-tokens/new",
		);
		const bad = await gitCredential({
			store: memStore(),
			prompt: prompt({ secrets: ["nope"] }).p,
			appName: "x",
			choice: "token",
			fetch: github().f,
		});
		expect(bad.ok).toBe(false);
	});

	test("an existing git token is kept", async () => {
		const r = await gitCredential({
			store: memStore({ GIT_TOKEN: "t" }),
			prompt: prompt().p,
			appName: "x",
		});
		expect(r).toEqual({ ok: true, detail: "GIT_TOKEN stored on this machine" });
	});

	test("app name: at most 34 characters, safe", () => {
		expect(defaultAppName("Acme Corp", "laptop.local")).toBe(
			"mm-acme-corp-laptop-local",
		);
		expect(defaultAppName("a".repeat(40), "b").length).toBeLessThanOrEqual(34);
	});
});

describe("onboard --json", () => {
	test("steps as JSON on stdout; the human lines on stderr", async () => {
		const { main, EXIT } = await import("../src/cli.ts");
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "mm-onboard-"));
		const out: string[] = [];
		const err: string[] = [];
		const code = await main(["onboard", "mme_x", "--queue", "q", "--json"], {
			env: {
				MASTERMIND_RUNNER_CONFIG: join(dir, "runner.json"),
				DOCKER_HOST: `unix://${join(dir, "no.sock")}`,
			},
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			cwd: dir,
			interactive: false,
		});
		expect(code).toBe(EXIT.error);
		const v = JSON.parse(out.join("\n"));
		expect(v.ready).toBe(false);
		expect(v.steps[0]).toMatchObject({ name: "box engine", ok: false });
		expect(v.steps[0].problem).toContain("does not answer");
		expect(err.join("\n")).toContain("NOT READY");
	});
});
