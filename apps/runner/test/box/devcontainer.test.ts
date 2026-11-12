/**
 * The box from devcontainer.json (mm-210.62), without an engine: config
 * lookup, cleaning, metadata, and prepareBox against a real local git repo
 * with a fake devcontainer CLI and a fake docker CLI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkAccess,
	classifyGitError,
	cleanConfig,
	type DevcontainerConfig,
	DevcontainerError,
	devcontainerCli,
	findConfig,
	type HostRun,
	hostRun,
	ignoredMetadata,
	layerDockerfile,
	lifecycleSteps,
	metadataEnv,
	metadataUser,
	namedConfigs,
	prepareBox,
} from "../../src/box/devcontainer.ts";
import { boxDockerPath } from "../../src/box/launcher.ts";
import { BoxStepError, runInBox } from "../../src/box/run.ts";
import { FakeDriver } from "./fake-driver.ts";

const tmp = mkdtempSync(join(tmpdir(), "mm-dc-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("findConfig", () => {
	const paths = [
		".devcontainer/devcontainer.json",
		".devcontainer.json",
		".devcontainer/python/devcontainer.json",
	];
	test("spec order: .devcontainer/devcontainer.json, then .devcontainer.json", () => {
		expect(findConfig(paths)).toBe(".devcontainer/devcontainer.json");
		expect(findConfig(paths.slice(1))).toBe(".devcontainer.json");
		expect(findConfig([".devcontainer/python/devcontainer.json"])).toBeNull();
		expect(findConfig([])).toBeNull();
	});
	test("configPath: a folder name under .devcontainer/ or a path", () => {
		expect(findConfig(paths, "python")).toBe(
			".devcontainer/python/devcontainer.json",
		);
		expect(findConfig(paths, ".devcontainer/python")).toBe(
			".devcontainer/python/devcontainer.json",
		);
		expect(findConfig(paths, "./.devcontainer.json")).toBe(
			".devcontainer.json",
		);
		expect(() => findConfig(paths, "go")).toThrow(
			".devcontainer/go/devcontainer.json is not in the repo",
		);
	});
	test("namedConfigs lists the folders", () => {
		expect(namedConfigs(paths)).toEqual(["python"]);
	});
});

describe("cleanConfig", () => {
	const cfg: DevcontainerConfig = {
		image: "debian",
		initializeCommand: "touch /tmp/x",
		runArgs: ["--privileged", "--network=host"],
		mounts: ["source=/,target=/host,type=bind"],
		privileged: true,
		capAdd: ["SYS_ADMIN"],
		securityOpt: ["seccomp=unconfined"],
		appPort: 3000,
		workspaceMount: "source=/,target=/w,type=bind",
		features: { "ghcr.io/devcontainers/features/node:1": {} },
		postCreateCommand: "npm i",
		secrets: { NPM_TOKEN: { description: "npm" } },
		customizations: {
			mastermind: { secrets: ["API_KEY"], instructions: "Run bun test." },
		},
	};
	test("removes every host field; keeps the box fields", () => {
		const c = cleanConfig(cfg);
		expect(c.removed.sort()).toEqual(
			[
				"initializeCommand",
				"runArgs",
				"mounts",
				"privileged",
				"capAdd",
				"securityOpt",
				"appPort",
				"workspaceMount",
			].sort(),
		);
		for (const f of c.removed) expect(f in c.config).toBe(false);
		expect(c.initializeCommand).toBeUndefined();
		expect(c.config.features).toEqual(cfg.features);
		expect(c.config.postCreateCommand).toBe("npm i");
		expect(c.recommendedSecrets).toEqual(["NPM_TOKEN"]);
		expect(c.requiredSecrets).toEqual(["API_KEY"]);
		expect(c.instructions).toBe("Run bun test.");
	});
	test("initializeCommand only when the environment allows it", () => {
		const c = cleanConfig(cfg, ["initializeCommand"]);
		expect(c.initializeCommand).toBe("touch /tmp/x");
		expect("initializeCommand" in c.config).toBe(false);
		expect(c.removed).not.toContain("initializeCommand");
	});
	test("build.options removed; Compose and no image refused", () => {
		const c = cleanConfig({
			build: { dockerfile: "Dockerfile", options: ["--network=host"] },
		});
		expect(c.config.build).toEqual({ dockerfile: "Dockerfile" });
		expect(c.removed).toEqual(["build.options"]);
		expect(() =>
			cleanConfig({ dockerComposeFile: "compose.yml", service: "app" }),
		).toThrow("Docker Compose is not supported");
		expect(() => cleanConfig({ name: "x" })).toThrow(
			"neither image nor build.dockerfile",
		);
	});
});

describe("image metadata", () => {
	const meta: DevcontainerConfig[] = [
		{ id: "ghcr.io/devcontainers/features/node:1", onCreateCommand: "a" },
		{
			id: "ghcr.io/devcontainers/features/docker-in-docker:2",
			privileged: true,
			entrypoint: "/usr/local/share/docker-init.sh",
			postCreateCommand: ["echo", "x y"],
		},
		{ remoteUser: "node", containerUser: "root" },
		{
			onCreateCommand: "b",
			postCreateCommand: { one: "c", two: ["d", "e"] },
			postStartCommand: "f",
			updateContentCommand: "",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: devcontainer syntax
			remoteEnv: { A: "1", P: "${containerEnv:PATH}:/x" },
			containerUser: "vscode",
		},
	];
	test("lifecycle order: each hook, features first", () => {
		expect(lifecycleSteps(meta)).toEqual([
			{
				what: "onCreateCommand (ghcr.io/devcontainers/features/node:1)",
				cmd: ["/bin/sh", "-c", "a"],
			},
			{
				what: "onCreateCommand (devcontainer.json)",
				cmd: ["/bin/sh", "-c", "b"],
			},
			{
				what: "postCreateCommand (ghcr.io/devcontainers/features/docker-in-docker:2)",
				cmd: ["echo", "x y"],
			},
			{
				what: "postCreateCommand (devcontainer.json: one)",
				cmd: ["/bin/sh", "-c", "c"],
			},
			{ what: "postCreateCommand (devcontainer.json: two)", cmd: ["d", "e"] },
			{
				what: "postStartCommand (devcontainer.json)",
				cmd: ["/bin/sh", "-c", "f"],
			},
		]);
	});
	test("user, env and what the driver does not apply", () => {
		expect(metadataUser(meta, "root")).toBe("node");
		expect(metadataUser([{ containerUser: "vscode" }], "")).toBe("vscode");
		expect(metadataUser([], "")).toBe("root");
		expect(metadataEnv(meta)).toEqual({ env: { A: "1" }, skipped: ["P"] });
		expect(ignoredMetadata(meta)).toEqual([
			"privileged (ghcr.io/devcontainers/features/docker-in-docker:2)",
			"entrypoint (ghcr.io/devcontainers/features/docker-in-docker:2)",
		]);
	});
	test("the layer copies the runtime from the default image", () => {
		const f = layerDockerfile(
			"mastermind-dc:k-base",
			"ghcr.io/x:box-1",
			"node",
		);
		expect(f).toStartWith(
			"FROM ghcr.io/x:box-1 AS mastermind\nFROM mastermind-dc:k-base\n",
		);
		expect(f).toContain('MM_BOX_USER="node"');
		expect(f).toContain('ENTRYPOINT ["/opt/mastermind/bin/box-entrypoint"]');
		expect(f).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile line
			"ENV PATH=/opt/mastermind/bin:${PATH}:/opt/mastermind/node/bin",
		);
	});
});

describe("CLI and docker path", () => {
	test("default: the pinned CLI through the runner's own Bun", () => {
		const c = devcontainerCli({}, "/usr/local/bin/mastermind-runner");
		expect(c.cmd).toEqual([
			"/usr/local/bin/mastermind-runner",
			"x",
			"--bun",
			"@devcontainers/cli@0.90.0",
		]);
		expect(c.env).toEqual({ BUN_BE_BUN: "1" });
		expect(
			devcontainerCli({ MM_DEVCONTAINER_CLI: "devcontainer" }).cmd,
		).toEqual(["devcontainer"]);
	});
	test("docker path follows the engine", () => {
		expect(boxDockerPath({}, "Podman Engine 5.6.0")).toBe("podman");
		expect(boxDockerPath({}, "Engine 28.0.1")).toBe("docker");
		expect(boxDockerPath({ MM_BOX_DOCKER_PATH: "/x/docker" }, "Podman")).toBe(
			"/x/docker",
		);
	});
});

// --- against a real git repo on this machine ---------------------------------

async function sh(cwd: string, ...cmd: string[]) {
	const r = await hostRun(cmd, { cwd });
	if (r.code !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

/** A repo with these files, committed on branch main. Returns its file:// URL. */
async function repo(name: string, files: Record<string, string>) {
	const dir = join(tmp, name);
	mkdirSync(dir, { recursive: true });
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), text);
	}
	await sh(dir, "git", "init", "-q", "-b", "main");
	await sh(dir, "git", "add", "-A");
	await sh(
		dir,
		"git",
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"init",
	);
	await sh(dir, "git", "config", "uploadpack.allowFilter", "true");
	return `file://${dir}`;
}

describe("checkAccess", () => {
	test("readable repo, missing ref, missing repo", async () => {
		const url = await repo("access", { "README.md": "hi\n" });
		expect(await checkAccess(url, "main", {})).toEqual({ ok: true });
		expect(await checkAccess(url, "", {})).toEqual({ ok: true });
		expect(await checkAccess(url, "abc1234", {})).toEqual({ ok: true });
		const missing = await checkAccess(url, "nope", {});
		expect(missing).toMatchObject({ ok: false, kind: "ref-missing" });
		const gone = await checkAccess(`file://${tmp}/no-such-repo`, "main", {});
		expect(gone).toMatchObject({ ok: false, kind: "no-access" });
		if (!gone.ok) expect(gone.reason).toContain("no git credential");
	});
	test("reasons by error, secret values redacted", () => {
		const r = (stderr: string) => ({ code: 128, stdout: "", stderr });
		const url = "https://github.com/acme/private.git";
		expect(
			classifyGitError(
				r(
					"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
				),
				url,
				{},
			),
		).toMatchObject({ kind: "no-access" });
		const bad = classifyGitError(
			r(
				"remote: Repository not found. tok-123456\nfatal: repository not found",
			),
			url,
			{ GIT_TOKEN: "tok-123456" },
		);
		expect(bad.kind).toBe("no-access");
		expect(bad.reason).toContain("with GIT_TOKEN");
		expect(bad.reason).not.toContain("tok-123456");
		expect(
			classifyGitError(
				r("fatal: unable to access: Could not resolve host: x"),
				url,
				{},
			),
		).toMatchObject({ kind: "network" });
	});
});

type Call = { cmd: string[]; env?: Record<string, string> };

/** Real git; a fake devcontainer CLI and docker CLI that record their calls. */
function fakeHost(meta: DevcontainerConfig[], user = "root") {
	const calls: Call[] = [];
	const images = new Set<string>();
	const run: HostRun = async (cmd, o = {}) => {
		if (cmd[0] === "git") return hostRun(cmd, o);
		calls.push({ cmd, ...(o.env ? { env: o.env } : {}) });
		if (cmd[0] === "fake-devcontainer") {
			const name = cmd[cmd.indexOf("--image-name") + 1] ?? "";
			images.add(name);
			return { code: 0, stdout: '{"outcome":"success"}\n', stderr: "" };
		}
		if (cmd[0] === "docker" && cmd[1] === "image") {
			const ref = cmd.at(-1) ?? "";
			if (!images.has(ref))
				return { code: 1, stdout: "", stderr: "no such image" };
			return {
				code: 0,
				stdout: JSON.stringify({
					User: user,
					Labels: { "devcontainer.metadata": JSON.stringify(meta) },
				}),
				stderr: "",
			};
		}
		if (cmd[0] === "docker" && cmd[1] === "build") {
			images.add(cmd[cmd.indexOf("-t") + 1] ?? "");
			return { code: 0, stdout: "sha256:x\n", stderr: "" };
		}
		if (cmd[0] === "/bin/sh") return hostRun(cmd, o);
		return { code: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
	};
	return { calls, run };
}

const deps = (run: HostRun) => ({
	defaultImage: "ghcr.io/x:box-1",
	dockerPath: "docker",
	run,
	cli: { cmd: ["fake-devcontainer"], env: {} },
});

describe("prepareBox", () => {
	const marker = join(tmp, "init-ran");
	const config = JSON.stringify({
		image: "mcr.microsoft.com/devcontainers/base:debian",
		features: { "ghcr.io/devcontainers/features/node:1": {} },
		initializeCommand: `touch ${marker}`,
		runArgs: ["--network=host"],
		postCreateCommand: "echo post > /tmp/post.ok",
		customizations: { mastermind: { instructions: "Use bun." } },
	});
	const meta: DevcontainerConfig[] = [
		{ id: "ghcr.io/devcontainers/features/node:1" },
		{ postCreateCommand: "echo post > /tmp/post.ok", remoteUser: "vscode" },
	];

	test("repo with .devcontainer/devcontainer.json: cleaned, built by the CLI, never initializeCommand", async () => {
		const url = await repo("with-config", {
			".devcontainer/devcontainer.json": `// a comment\n${config}`,
			"README.md": "x",
		});
		const h = fakeHost(meta);
		const steps: string[] = [];
		const p = await prepareBox(
			{ beadId: "mm-1", env: { repo: url, ref: "main" }, secrets: {} },
			deps(h.run),
			(l) => steps.push(l),
		);
		expect(p?.image).toMatch(/^mastermind-dc:[0-9a-f]{16}$/);
		expect(p?.user).toBe("vscode");
		expect(p?.lifecycle).toEqual([
			{
				what: "postCreateCommand (devcontainer.json)",
				cmd: ["/bin/sh", "-c", "echo post > /tmp/post.ok"],
			},
		]);
		expect(p?.instructions).toBe("Use bun.");
		expect(existsSync(marker)).toBe(false);
		const build = h.calls.find((c) => c.cmd[0] === "fake-devcontainer");
		expect(build?.cmd).toContain("--config");
		expect(build?.cmd.at(build.cmd.indexOf("--config") + 1)).toEndWith(
			".devcontainer/.mastermind.devcontainer.json",
		);
		expect(build?.cmd).toContain(`${p?.image}-base`);
		expect(
			h.calls.some((c) => c.cmd[0] === "docker" && c.cmd[1] === "build"),
		).toBe(true);
		expect(steps.join("\n")).toContain(
			"not applied (they reach the host): initializeCommand, runArgs",
		);

		// The second task uses the cached image: no build.
		const again = fakeHost(meta);
		await prepareBox(
			{ beadId: "mm-1", env: { repo: url, ref: "main" }, secrets: {} },
			{ ...deps(again.run) },
			() => {},
		);
		// (a new fake host has no images: it builds again; the key is stable)
		const k2 = again.calls.find((c) => c.cmd[0] === "fake-devcontainer");
		expect(k2?.cmd).toContain(`${p?.image}-base`);
	});

	test("initializeCommand runs on this machine only when the environment allows it", async () => {
		const url = await repo("allow-init", {
			".devcontainer.json": config,
		});
		const h = fakeHost(meta);
		await prepareBox(
			{
				beadId: "mm-1",
				env: {
					repo: url,
					ref: "main",
					devcontainer: { allowHost: ["initializeCommand"] },
				},
				secrets: {},
			},
			deps(h.run),
			() => {},
		);
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
	});

	test("repo without a config: the default image (null)", async () => {
		const url = await repo("no-config", {
			"README.md": "x",
			".devcontainer/python/devcontainer.json": config,
		});
		const h = fakeHost(meta);
		const steps: string[] = [];
		const p = await prepareBox(
			{ beadId: "mm-1", env: { repo: url, ref: "main" }, secrets: {} },
			deps(h.run),
			(l) => steps.push(l),
		);
		expect(p).toBeNull();
		expect(h.calls).toEqual([]);
		expect(steps.at(-1)).toContain("name one in the environment's configPath");
	});

	test("the environment's own config wins; an image recipe keeps the recipe", async () => {
		const url = await repo("own-config", { "README.md": "x" });
		const h = fakeHost(meta);
		const p = await prepareBox(
			{
				beadId: "mm-1",
				env: { repo: url, ref: "main", devcontainer: { config } },
				secrets: {},
			},
			deps(h.run),
			() => {},
		);
		expect(p?.image).toStartWith("mastermind-dc:");
		const h2 = fakeHost(meta);
		expect(
			await prepareBox(
				{
					beadId: "mm-1",
					env: { repo: url, ref: "main", image: "node:22" },
					secrets: {},
				},
				deps(h2.run),
				() => {},
			),
		).toBeNull();
		expect(h2.calls).toEqual([]);
	});

	test("required secrets of customizations.mastermind; recommended ones only noted", async () => {
		const url = await repo("secrets", {
			".devcontainer.json": JSON.stringify({
				image: "debian",
				secrets: { NPM_TOKEN: {} },
				customizations: { mastermind: { secrets: ["API_KEY"] } },
			}),
		});
		const t = { beadId: "mm-1", env: { repo: url, ref: "main" }, secrets: {} };
		await expect(
			prepareBox(t, deps(fakeHost(meta).run), () => {}),
		).rejects.toThrow(
			"missing secrets named in .devcontainer.json (customizations.mastermind.secrets): API_KEY",
		);
		const steps: string[] = [];
		const p = await prepareBox(
			t,
			{
				...deps(fakeHost(meta).run),
				lookupSecrets: async (names) => ({
					values: (names.includes("API_KEY") ? { API_KEY: "v" } : {}) as Record<
						string,
						string
					>,
					missing: names.filter((n) => n !== "API_KEY"),
				}),
			},
			(l) => steps.push(l),
		);
		expect(p?.secrets).toEqual({ API_KEY: "v" });
		expect(steps.join("\n")).toContain(
			"recommended secrets not set on this runner: NPM_TOKEN",
		);
	});

	test("no access: a clear reason, nothing built", async () => {
		const h = fakeHost(meta);
		await expect(
			prepareBox(
				{
					beadId: "mm-1",
					env: { repo: `file://${tmp}/private`, ref: "main" },
					secrets: {},
				},
				deps(h.run),
				() => {},
			),
		).rejects.toThrow(DevcontainerError);
		expect(h.calls).toEqual([]);
	});
});

describe("runInBox with prepare", () => {
	const base = {
		executionId: "mm-2-1",
		beadId: "mm-2",
		runnerId: "laptop",
		title: "t",
		prompt: "do it",
		agent: {},
		secrets: { A: "a-value" },
		env: {
			repo: "https://github.com/acme/web.git",
			ref: "main",
			requires: [],
			setup: ["make"],
		},
	};
	test("a failed access check fails the task before any box", async () => {
		const d = new FakeDriver();
		await expect(
			runInBox(
				base,
				{
					driver: d,
					defaultImage: "img",
					prepare: async () => {
						throw new DevcontainerError(
							"no access to https://github.com/acme/web.git: ...",
						);
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow(BoxStepError);
		expect(d.created).toEqual([]);
		expect(d.images).toEqual([]);
	});
	test("the devcontainer image, its user, env, secrets and lifecycle before setup", async () => {
		const d = new FakeDriver();
		await runInBox(
			base,
			{
				driver: d,
				defaultImage: "img",
				readyCommand: null,
				prepare: async () => ({
					image: "mastermind-dc:k",
					user: "vscode",
					lifecycle: [
						{
							what: "postCreateCommand (devcontainer.json)",
							cmd: ["/bin/sh", "-c", "npm i"],
						},
					],
					env: { FROM_META: "1" },
					secrets: { NPM_TOKEN: "npm-value" },
					instructions: "Use bun.",
				}),
			},
			new AbortController().signal,
		);
		expect(d.images).toEqual([]);
		const spec = d.created[0];
		expect(spec?.image).toBe("mastermind-dc:k");
		expect(spec?.env).toMatchObject({
			FROM_META: "1",
			NPM_TOKEN: "npm-value",
			A: "a-value",
		});
		const lines = d.execs.map((e) => e.cmd.join(" "));
		const post = lines.indexOf("/bin/sh -c npm i");
		const setup = lines.indexOf("sh -c make");
		expect(post).toBeGreaterThan(-1);
		expect(setup).toBeGreaterThan(post);
		expect(d.execs[post]?.opts.user).toBe("vscode");
		expect(lines.some((l) => l.startsWith("id -u paseo"))).toBe(false);
		const agent = d.execs.find(
			(e) => e.cmd[0] === "paseo" && e.cmd[1] === "run",
		);
		expect(agent?.cmd.at(-1)).toBe("do it\n\nUse bun.");
	});
});
