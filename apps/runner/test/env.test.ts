/**
 * env init and env test (mm-210.67). init writes and merges
 * .devcontainer/devcontainer.json with a customizations.mastermind block and
 * validates it; a second run changes nothing. env test runs the repo's
 * environment on the task path (prepareBox + runInBox) with real git, a fake
 * devcontainer CLI and a fake box driver: PASS per step, the box deleted.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostRun, hostRun } from "../src/box/devcontainer.ts";
import {
	EnvInitError,
	hasComments,
	initEnvironment,
	parseNetwork,
	validateDevcontainer,
} from "../src/env.ts";
import { type EnvTestStep, envTest, fixFor } from "../src/env-test.ts";
import { FakeDriver } from "./box/fake-driver.ts";

// Real git repos: slow when the machine is busy.
setDefaultTimeout(30_000);

const tmp = mkdtempSync(join(tmpdir(), "mm-env-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function sh(cwd: string, ...cmd: string[]) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0)
		throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
}

describe("env init", () => {
	test("creates the file with the block; valid; a second run is unchanged", async () => {
		const dir = join(tmp, "init1");
		mkdirSync(dir);
		const r = await initEnvironment(dir, {
			secrets: ["DOCS_KEY"],
			network: parseNetwork("github.com, registry.npmjs.org"),
			output: "pr",
			check: ["bun test"],
		});
		expect(r.action).toBe("created");
		expect(r.path).toBe(join(dir, ".devcontainer/devcontainer.json"));
		expect(r.validation).toMatchObject({ ok: true, errors: [] });
		const v = JSON.parse(await Bun.file(r.path).text());
		expect(v.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
		expect(v.customizations.mastermind).toEqual({
			secrets: ["DOCS_KEY"],
			network: { allow: ["github.com", "registry.npmjs.org"] },
			output: { kind: "pr" },
			check: ["bun test"],
		});
		const again = await initEnvironment(dir, { secrets: ["DOCS_KEY"] });
		expect(again.action).toBe("unchanged");
	});

	test("merges into an existing file and keeps its fields", async () => {
		const dir = join(tmp, "init2");
		mkdirSync(join(dir, ".devcontainer"), { recursive: true });
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			JSON.stringify({
				image: "node:22",
				features: { x: {} },
				customizations: {
					vscode: { extensions: ["a"] },
					mastermind: { secrets: ["A"] },
				},
			}),
		);
		const r = await initEnvironment(dir, { secrets: ["B"], output: "branch" });
		expect(r.action).toBe("updated");
		const v = JSON.parse(await Bun.file(r.path).text());
		expect(v.image).toBe("node:22");
		expect(v.features).toEqual({ x: {} });
		expect(v.customizations.vscode).toEqual({ extensions: ["a"] });
		expect(v.customizations.mastermind.secrets).toEqual(["A", "B"]);
		expect(v.customizations.mastermind.output).toEqual({ kind: "branch" });
	});

	test("a file with comments is not rewritten without --force", async () => {
		const dir = join(tmp, "init3");
		mkdirSync(dir);
		writeFileSync(
			join(dir, ".devcontainer.json"),
			'// mine\n{"image":"node:22"}',
		);
		await expect(initEnvironment(dir, { secrets: ["A"] })).rejects.toThrow(
			EnvInitError,
		);
		const r = await initEnvironment(dir, { secrets: ["A"], force: true });
		expect(r.path).toBe(join(dir, ".devcontainer.json"));
		expect(hasComments('{"url":"http://x"}')).toBe(false);
	});

	test("validation names what the runner refuses or removes", () => {
		const v = validateDevcontainer(
			JSON.stringify({
				image: "alpine:3",
				runArgs: ["--privileged"],
				customizations: {
					mastermind: {
						secrets: ["bad-name"],
						network: { allow: ["not a host"] },
						output: { kind: "x" },
					},
				},
			}),
			"f",
		);
		expect(v.ok).toBe(false);
		expect(v.errors.join("\n")).toContain("Alpine");
		expect(v.errors.join("\n")).toContain('secret name "bad-name"');
		expect(v.errors.join("\n")).toContain("network");
		expect(v.errors.join("\n")).toContain("output.kind");
		expect(v.warnings.join("\n")).toContain("runArgs");
		expect(
			validateDevcontainer('{"dockerComposeFile":"x"}', "f").errors[0],
		).toContain("Compose");
		expect(() => parseNetwork("a b")).toThrow(EnvInitError);
	});
});

/** Real git; a fake devcontainer CLI and docker CLI. */
function fakeHost(): HostRun {
	const images = new Set<string>();
	return async (cmd, o = {}) => {
		if (cmd[0] === "git") return hostRun(cmd, o);
		if (cmd[0] === "fake-devcontainer") {
			images.add(cmd[cmd.indexOf("--image-name") + 1] ?? "");
			return { code: 0, stdout: '{"outcome":"success"}\n', stderr: "" };
		}
		if (cmd[0] === "docker" && cmd[1] === "image") {
			const ref = cmd.at(-1) ?? "";
			if (!images.has(ref))
				return { code: 1, stdout: "", stderr: "no such image" };
			return {
				code: 0,
				stdout: JSON.stringify({
					User: "root",
					Labels: {
						"devcontainer.metadata": JSON.stringify([
							{ postCreateCommand: "echo hi" },
						]),
					},
				}),
				stderr: "",
			};
		}
		if (cmd[0] === "docker" && cmd[1] === "build") {
			images.add(cmd[cmd.indexOf("-t") + 1] ?? "");
			return { code: 0, stdout: "sha256:x\n", stderr: "" };
		}
		return { code: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
	};
}

async function sampleRepo(name: string, config: object) {
	const origin = join(tmp, `${name}-origin`);
	mkdirSync(join(origin, ".devcontainer"), { recursive: true });
	writeFileSync(
		join(origin, ".devcontainer/devcontainer.json"),
		JSON.stringify(config),
	);
	writeFileSync(join(origin, "README.md"), "x");
	await sh(origin, "git", "init", "-q", "-b", "main");
	await sh(origin, "git", "add", "-A");
	await sh(
		origin,
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
	await sh(origin, "git", "config", "uploadpack.allowFilter", "true");
	const work = join(tmp, `${name}-work`);
	await sh(tmp, "git", "clone", "-q", `file://${origin}`, work);
	return work;
}

const base = (
	dir: string,
	driver: FakeDriver,
	steps: EnvTestStep[],
	secrets = {},
) => ({
	dir,
	deep: false,
	agent: {},
	defaultImage: "ghcr.io/x:box-1",
	env: {},
	loadSecrets: async () => secrets,
	driver,
	emit: (s: EnvTestStep) => steps.push(s),
	run: fakeHost(),
	cli: { cmd: ["fake-devcontainer"], env: {} },
});

describe("env test", () => {
	test("sample repo: every step PASS on the task path; the box is deleted; no agent without --deep", async () => {
		const dir = await sampleRepo("ok", {
			image: "mcr.microsoft.com/devcontainers/base:ubuntu",
			customizations: {
				mastermind: { secrets: ["DOCS_KEY"], check: ["true"] },
			},
		});
		const driver = new FakeDriver();
		// The fake driver runs no shell: answer the stub agent like sh would.
		driver.handler = (cmd) => {
			const line = cmd.join(" ");
			return line.includes("no agent")
				? {
						code: 0,
						stdout: line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1),
						stderr: "",
					}
				: undefined;
		};
		const steps: EnvTestStep[] = [];
		const ok = await envTest(base(dir, driver, steps, { DOCS_KEY: "v" }));
		const text = steps
			.map((s) => `${s.ok ? "PASS" : "FAIL"} ${s.step}: ${s.detail}`)
			.join("\n");
		expect(ok).toBe(true);
		expect(text).toContain(
			"PASS config: .devcontainer/devcontainer.json is valid",
		);
		expect(text).toContain(
			`PASS repo: file://${join(tmp, "ok-origin")} at main`,
		);
		expect(text).toContain("PASS secrets: DOCS_KEY present");
		expect(text).toContain("access check");
		expect(text).toContain("setup and check passed");
		expect(text).toMatch(/PASS box: box \S+ deleted/);
		expect(text).toContain("PASS result: no agent");
		expect(driver.created.length).toBe(1);
		expect(driver.boxes.size).toBe(0);
		expect(driver.execs.some((e) => e.cmd[0] === "paseo")).toBe(false);
		// The secret value never shows.
		expect(text).not.toContain(": v");
	});

	test("a missing secret: FAIL with the command that fixes it; no box", async () => {
		const dir = await sampleRepo("nosecret", {
			image: "mcr.microsoft.com/devcontainers/base:ubuntu",
			customizations: { mastermind: { secrets: ["DOCS_KEY"] } },
		});
		const driver = new FakeDriver();
		const steps: EnvTestStep[] = [];
		expect(await envTest(base(dir, driver, steps))).toBe(false);
		expect(steps.at(-1)).toMatchObject({
			step: "secrets",
			ok: false,
			fix: "mastermind-runner secrets set DOCS_KEY",
		});
		expect(driver.created.length).toBe(0);
	});

	test("a local edit of devcontainer.json is tested before the commit", async () => {
		const dir = await sampleRepo("edit", {
			image: "mcr.microsoft.com/devcontainers/base:ubuntu",
		});
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			JSON.stringify({
				image: "mcr.microsoft.com/devcontainers/base:ubuntu",
				customizations: { mastermind: { check: ["false"] } },
			}),
		);
		const driver = new FakeDriver();
		driver.handler = (cmd) =>
			cmd.join(" ").includes("false")
				? { code: 1, stdout: "", stderr: "nope" }
				: undefined;
		const steps: EnvTestStep[] = [];
		expect(await envTest(base(dir, driver, steps))).toBe(false);
		const last = steps.at(-1);
		expect(last?.step).toBe("box");
		expect(last?.detail).toContain("check `false`");
		expect(last?.fix).toContain("customizations.mastermind.check");
		expect(driver.boxes.size).toBe(0);
	});

	test("no config: points to env init", async () => {
		const dir = join(tmp, "empty");
		mkdirSync(dir);
		const steps: EnvTestStep[] = [];
		expect(await envTest(base(dir, new FakeDriver(), steps))).toBe(false);
		expect(steps[0]?.fix).toBe(`mastermind-runner env init ${dir}`);
	});

	test("fixes by message", () => {
		expect(fixFor("no access: the repo is private")).toContain("GitHub App");
		expect(fixFor("ref missing: feature")).toContain("push the branch");
		expect(fixFor("devcontainer build failed")).toContain("devcontainer build");
	});
});

describe("env command", () => {
	test("env init through the CLI: flags only, then valid; env test on no directory is a usage error", async () => {
		const { main, EXIT } = await import("../src/cli.ts");
		const dir = join(tmp, "cli-init");
		mkdirSync(dir);
		const out: string[] = [];
		const io = {
			env: {
				MASTERMIND_RUNNER_CONFIG: join(tmp, "cli-init-cfg", "runner.json"),
			},
			out: (l: string) => out.push(l),
			err: (l: string) => out.push(l),
			cwd: dir,
			interactive: false,
		};
		expect(
			await main(
				[
					"env",
					"init",
					".",
					"--secret",
					"DOCS_KEY",
					"--network",
					"github.com",
					"--output",
					"branch",
				],
				io,
			),
		).toBe(EXIT.ok);
		expect(out[0]).toBe(
			`created: ${join(dir, ".devcontainer/devcontainer.json")}`,
		);
		expect(out.at(-1)).toContain("mastermind-runner env test .");
		expect(await main(["env", "init", ".", "--output", "zip"], io)).toBe(
			EXIT.usage,
		);
		expect(await main(["env", "test", "no-such-dir"], io)).toBe(EXIT.usage);
	});
});
