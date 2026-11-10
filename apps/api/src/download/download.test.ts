import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScript } from "./install-script.ts";
import { downloadRoutes, requestOrigin, targetOf } from "./routes.ts";
import {
	MANIFEST,
	type Manifest,
	parseTargets,
	sha256,
	TARGETS,
} from "./runner-build.ts";

const dir = mkdtempSync(join(tmpdir(), "mm-download-"));
const runners = join(dir, "runner");
/** A stand-in "binary" per target: a script that prints its target. */
const fake = (t: string) =>
	new TextEncoder().encode(`#!/bin/sh\necho "fake-${t}"\n`);
let server: ReturnType<typeof Bun.serve>;
let base: string;

async function writeManifest(tamper?: string) {
	const m: Manifest = { version: "abc", targets: {} };
	for (const t of TARGETS) {
		const exe = fake(t);
		await Bun.write(join(runners, `${t}.gz`), Bun.gzipSync(exe));
		m.targets[t] = {
			file: `${t}.gz`,
			gzip: true,
			// A changed file: the published sha256 is not the one of the file.
			sha256: t === tamper ? sha256(fake("other")) : sha256(exe),
			size: exe.length,
		};
	}
	await Bun.write(join(runners, MANIFEST), JSON.stringify(m));
}

beforeAll(async () => {
	await writeManifest();
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		routes: downloadRoutes({ dir: runners, source: null }),
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

const sh = async (script: string, home: string) => {
	const p = Bun.spawn(["sh", "-c", script], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { out, err, code };
};

const hostTarget = () => {
	const os = process.platform === "darwin" ? "darwin" : "linux";
	return `${os}-${process.arch === "arm64" ? "arm64" : "x64"}`;
};

test("parseTargets", () => {
	expect(parseTargets("all")).toEqual([...TARGETS]);
	expect(parseTargets(" linux-x64, darwin-arm64,linux-x64 ")).toEqual([
		"linux-x64",
		"darwin-arm64",
	]);
	expect(parseTargets("")).toEqual([]);
	expect(() => parseTargets("windows-x64")).toThrow("unknown runner target");
});

test("targetOf", () => {
	const u = (q: string) => new URL(`http://x/d?${q}`);
	expect(targetOf(u("os=linux&arch=x64"))).toBe("linux-x64");
	expect(targetOf(u("os=darwin&arch=arm64"))).toBe("darwin-arm64");
	expect(targetOf(u("os=linux"))).toContain("pass os");
	expect(targetOf(u("os=windows&arch=x64"))).toBe(
		"no runner build for windows-x64",
	);
});

test("requestOrigin: forwarded headers first, unsafe hosts ignored", () => {
	const req = (h: Record<string, string>) =>
		new Request("http://10.0.0.5:3000/install.sh", { headers: h });
	expect(requestOrigin(req({}))).toBe("http://10.0.0.5:3000");
	expect(
		requestOrigin(
			req({ "x-forwarded-proto": "https", "x-forwarded-host": "mm.example" }),
		),
	).toBe("https://mm.example");
	expect(
		requestOrigin(req({ "x-forwarded-proto": "https", host: "mm.example" })),
	).toBe("https://mm.example");
	expect(requestOrigin(req({ "x-forwarded-host": "a'$(rm -rf ~)" }))).toBe(
		"http://10.0.0.5:3000",
	);
});

test("installScript refuses an origin that is not safe to quote", () => {
	expect(() => installScript("http://x'y")).toThrow("unsafe origin");
	expect(installScript("https://mm.example")).toContain(
		"origin='https://mm.example'",
	);
});

describe("downloads", () => {
	test("sha256 and the binary, gzip or not", async () => {
		const q = "os=linux&arch=arm64";
		const sum = await fetch(`${base}/download/mastermind-runner.sha256?${q}`);
		expect(await sum.text()).toBe(
			`${sha256(fake("linux-arm64"))}  mastermind-runner\n`,
		);
		const gz = await fetch(`${base}/download/mastermind-runner?${q}`, {
			headers: { "accept-encoding": "gzip" },
			decompress: false,
		});
		expect(gz.headers.get("content-encoding")).toBe("gzip");
		expect(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer()))).toEqual(
			fake("linux-arm64"),
		);
		const plain = await fetch(`${base}/download/mastermind-runner?${q}`, {
			headers: { "accept-encoding": "identity" },
		});
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(await plain.bytes()).toEqual(fake("linux-arm64"));
	});

	test("bad or missing target", async () => {
		const bad = await fetch(
			`${base}/download/mastermind-runner?os=plan9&arch=x64`,
		);
		expect(bad.status).toBe(400);
		const empty = downloadRoutes({ dir: join(dir, "none"), source: null });
		const res = await empty["/download/mastermind-runner"].GET(
			new Request("http://x/download/mastermind-runner?os=linux&arch=x64"),
		);
		expect(res.status).toBe(404);
	});

	test("install.sh names the origin it was fetched from", async () => {
		const text = await (
			await fetch(`${base}/install.sh`, {
				headers: {
					"x-forwarded-proto": "https",
					"x-forwarded-host": "mm.example",
				},
			})
		).text();
		expect(text).toStartWith("#!/bin/sh");
		expect(text).toContain("origin='https://mm.example'");
	});

	test("curl | sh installs the runner for this machine", async () => {
		const home = mkdtempSync(join(dir, "home-"));
		const r = await sh(`curl -fsSL ${base}/install.sh | sh`, home);
		expect(r.err).not.toContain("mismatch");
		expect(r.code).toBe(0);
		const bin = join(home, ".local/bin/mastermind-runner");
		expect(existsSync(bin)).toBe(true);
		expect(r.out).toContain(`(version fake-${hostTarget()})`);
		expect(r.out).toContain("is not on PATH");
	});

	test("a changed file fails the sha256 check and installs nothing", async () => {
		await writeManifest(hostTarget());
		const tampered = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			routes: downloadRoutes({ dir: runners, source: null }),
		});
		try {
			const home = mkdtempSync(join(dir, "home-"));
			const r = await sh(
				`curl -fsSL http://127.0.0.1:${tampered.port}/install.sh | sh`,
				home,
			);
			expect(r.code).not.toBe(0);
			expect(r.err).toContain("sha256 mismatch");
			expect(existsSync(join(home, ".local/bin/mastermind-runner"))).toBe(
				false,
			);
		} finally {
			tampered.stop(true);
			await writeManifest();
		}
	});
});
