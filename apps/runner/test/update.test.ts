import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
	runnerTarget,
	selfUpdate,
	UpdateError,
	type UpdateResult,
	versionWatch,
} from "../src/update.ts";

const OLD = "2f22252aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "ce20fc6bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const URL = "https://mm.example";

/** A runner "binary" that is a shell script printing its version. */
const script = (v: string) => `#!/bin/sh\necho ${v}\n`;
const hex = (s: string) =>
	new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** The server: /api/health, the sha256 and the binary; records the requests. */
function server(o: { version?: string; binary?: string; sha?: string } = {}) {
	const binary = o.binary ?? script(NEW);
	const seen: string[] = [];
	const fetchFn = (async (input: string | URL | Request) => {
		const u = new globalThis.URL(String(input));
		seen.push(`${u.pathname}${u.search}`);
		if (u.pathname === "/api/health")
			return Response.json({ ok: true, version: o.version ?? NEW });
		if (u.pathname === "/download/mastermind-runner.sha256")
			return new Response(`${o.sha ?? hex(binary)}  mastermind-runner\n`);
		if (u.pathname === "/download/mastermind-runner")
			return new Response(binary);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchFn, seen };
}

let dir = "";
const exeIn = async () => {
	dir = await mkdtemp(join(tmpdir(), "mm-update-"));
	const exe = join(dir, "mastermind-runner");
	await Bun.write(exe, script(OLD));
	return exe;
};
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = "";
});

describe("selfUpdate", () => {
	test("downloads the server's runner, checks sha256, starts it, replaces the executable", async () => {
		const exe = await exeIn();
		const s = server();
		const r = await selfUpdate({
			url: `${URL}/`,
			version: OLD,
			exe,
			fetch: s.fetch,
			platform: "linux",
			arch: "x64",
		});
		// The real `<new> --version` ran (a shell script here).
		expect(r).toEqual({ state: "updated", from: OLD, to: NEW, path: exe });
		expect(await Bun.file(exe).text()).toBe(script(NEW));
		expect(s.seen).toContain("/download/mastermind-runner?os=linux&arch=x64");
		expect(await readdir(dir)).toEqual(["mastermind-runner"]);
	});

	test("sha256 mismatch: nothing replaced, no temp file left", async () => {
		const exe = await exeIn();
		const s = server({ sha: "0".repeat(64) });
		const err = await selfUpdate({
			url: URL,
			version: OLD,
			exe,
			fetch: s.fetch,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(UpdateError);
		expect(err.message).toContain("sha256 mismatch");
		expect(await Bun.file(exe).text()).toBe(script(OLD));
		expect(await readdir(dir)).toEqual(["mastermind-runner"]);
	});

	test("a new binary that does not start: nothing replaced", async () => {
		const exe = await exeIn();
		const s = server({ binary: "#!/bin/sh\nexit 3\n" });
		const err = await selfUpdate({
			url: URL,
			version: OLD,
			exe,
			fetch: s.fetch,
		}).catch((e) => e);
		expect(err.message).toContain("does not start");
		expect(await Bun.file(exe).text()).toBe(script(OLD));
		expect(await readdir(dir)).toEqual(["mastermind-runner"]);
	});

	test("--check and same version: nothing downloaded", async () => {
		const exe = await exeIn();
		const s = server();
		const check = await selfUpdate({
			url: URL,
			version: OLD,
			exe,
			check: true,
			fetch: s.fetch,
		});
		expect(check).toMatchObject({
			state: "available",
			notice:
				"runner 2f22252 is older than the server ce20fc6: run mastermind-runner update",
		});
		const same = await selfUpdate({
			url: URL,
			version: NEW,
			exe,
			fetch: s.fetch,
		});
		expect(same.state).toBe("current");
		expect(s.seen.every((p) => p === "/api/health")).toBe(true);
		expect(await Bun.file(exe).text()).toBe(script(OLD));
	});

	test("run from source (dev) or under bun: refused", async () => {
		const s = server();
		await expect(
			selfUpdate({ url: URL, version: "dev", fetch: s.fetch }),
		).rejects.toThrow("runs from source");
		await expect(
			selfUpdate({
				url: URL,
				version: OLD,
				exe: "/usr/bin/bun",
				fetch: s.fetch,
			}),
		).rejects.toThrow("runs under bun");
	});

	test("target: linux and darwin, x64 and arm64", () => {
		expect(runnerTarget("darwin", "arm64")).toEqual({
			os: "darwin",
			arch: "arm64",
		});
		expect(() => runnerTarget("win32", "x64")).toThrow(UpdateError);
	});
});

describe("versionWatch", () => {
	const updated: UpdateResult = {
		state: "updated",
		from: OLD,
		to: NEW,
		path: "/x",
	};
	function watch(o: { server?: string; autoUpdate?: boolean; idle?: boolean }) {
		const calls: string[] = [];
		const notices: (string | null)[] = [];
		const draining: (string | null)[] = [];
		let idle = o.idle ?? true;
		const w = versionWatch({
			version: OLD,
			serverVersion: async () => o.server ?? NEW,
			autoUpdate: o.autoUpdate ?? false,
			idle: () => idle,
			waitIdle: async () => {
				calls.push("waitIdle");
				idle = true;
			},
			update: async () => {
				calls.push(`update (idle ${idle})`);
				return updated;
			},
			restart: (to) => calls.push(`restart ${to}`),
			onNotice: (n) => notices.push(n),
			onDraining: (d) => draining.push(d),
			log: (l) => calls.push(`log ${l}`),
		});
		return { w, calls, notices, draining };
	}

	test("an old runner says the notice once per server version, and does not update by default", async () => {
		const { w, calls, notices } = watch({});
		await w.tick();
		await w.tick();
		expect(notices).toEqual([
			"runner 2f22252 is older than the server ce20fc6: run mastermind-runner update",
		]);
		expect(calls).toEqual([
			"log warning: runner 2f22252 is older than the server ce20fc6: run mastermind-runner update",
		]);
	});

	test("same version: no notice, no update", async () => {
		const { w, calls, notices } = watch({ server: OLD, autoUpdate: true });
		await w.tick();
		expect(notices).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("--auto-update while a task runs: no new work, waits, then updates and restarts", async () => {
		const { w, calls, draining } = watch({ autoUpdate: true, idle: false });
		await w.tick();
		const steps = calls.filter((c) => !c.startsWith("log"));
		expect(steps).toEqual(["waitIdle", "update (idle true)", `restart ${NEW}`]);
		expect(draining[0]).toContain("no new work");
	});

	test("--auto-update when idle: updates at once; a failure keeps the runner and takes work again", async () => {
		const ok = watch({ autoUpdate: true });
		await ok.w.tick();
		expect(ok.calls.filter((c) => !c.startsWith("log"))).toEqual([
			"update (idle true)",
			`restart ${NEW}`,
		]);

		const logs: string[] = [];
		const draining: (string | null)[] = [];
		const failing = versionWatch({
			version: OLD,
			serverVersion: async () => NEW,
			autoUpdate: true,
			idle: () => true,
			waitIdle: async () => {},
			update: async () => {
				throw new UpdateError("sha256 mismatch");
			},
			restart: () => logs.push("restart"),
			onNotice: () => {},
			onDraining: (d) => draining.push(d),
			log: (l) => logs.push(l),
		});
		await failing.tick();
		expect(logs).not.toContain("restart");
		expect(logs.some((l) => l.startsWith("error: auto-update failed"))).toBe(
			true,
		);
		expect(draining.at(-1)).toBeNull();
	});
});

describe("cli update", () => {
	const io = (fetchFn: typeof fetch, exe: string) => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: {
				env: { MASTERMIND_RUNNER_CONFIG: join(dir, "none.json") },
				out: (l: string) => out.push(l),
				err: (l: string) => err.push(l),
				cwd: dir,
				fetch: fetchFn,
				exe,
				runVersion: async () => NEW,
			},
		};
	};

	test("from source (dev) update is refused; no url is a usage error", async () => {
		const exe = await exeIn();
		const s = server();
		const a = io(s.fetch, exe);
		// Tests run from source: VERSION is "dev".
		expect(await main(["update", "--url", URL], a.io)).toBe(1);
		expect(a.err.join("\n")).toContain("runs from source");
		const b = io(s.fetch, exe);
		expect(await main(["update"], b.io)).toBe(2);
		expect(b.err.join("\n")).toContain("update needs --url");
	});
});
