import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Demux,
	DockerDriver,
	dockerEndpoint,
	dockerfile,
	splitRef,
} from "../../src/box/docker.ts";
import { BoxError, imageHash } from "../../src/box/driver.ts";
import { tar, untar } from "../../src/box/tar.ts";

function frame(stream: 1 | 2, text: string): Uint8Array {
	const body = new TextEncoder().encode(text);
	const f = new Uint8Array(8 + body.length);
	f[0] = stream;
	new DataView(f.buffer).setUint32(4, body.length);
	f.set(body, 8);
	return f;
}

describe("tar", () => {
	test("round trip", () => {
		const files = untar(
			tar([
				{ name: "a.txt", data: "hello" },
				{ name: "dir/b.bin", data: new Uint8Array(1000).fill(7), mode: 0o400 },
			]),
		);
		expect(files.map((f) => f.name)).toEqual(["a.txt", "dir/b.bin"]);
		expect(new TextDecoder().decode(files[0]?.data)).toBe("hello");
		expect(files[1]?.data.length).toBe(1000);
	});
});

describe("Demux", () => {
	test("splits stdout and stderr frames, also across chunks", () => {
		const d = new Demux();
		const all = new Uint8Array([
			...frame(1, "out1 "),
			...frame(2, "err"),
			...frame(1, "out2"),
		]);
		d.push(all.subarray(0, 3));
		d.push(all.subarray(3, 20));
		d.push(all.subarray(20));
		expect(d.stdout).toBe("out1 out2");
		expect(d.stderr).toBe("err");
	});
});

describe("helpers", () => {
	test("dockerEndpoint", () => {
		expect(dockerEndpoint({ DOCKER_HOST: "unix:///x/d.sock" })).toMatchObject({
			unix: "/x/d.sock",
		});
		expect(dockerEndpoint({ DOCKER_HOST: "tcp://10.0.0.2:2375" }).base).toBe(
			"http://10.0.0.2:2375",
		);
		expect(() => dockerEndpoint({ DOCKER_HOST: "ssh://h" })).toThrow(BoxError);
		expect(dockerEndpoint({}, () => true).unix).toBe("/var/run/docker.sock");
		expect(
			dockerEndpoint(
				{ XDG_RUNTIME_DIR: "/run/user/7" },
				(p) => p === "/run/user/7/podman/podman.sock",
			).unix,
		).toBe("/run/user/7/podman/podman.sock");
	});
	test("splitRef", () => {
		expect(splitRef("ghcr.io/getpaseo/paseo:0.15.4")).toEqual({
			repo: "ghcr.io/getpaseo/paseo",
			tag: "0.15.4",
		});
		expect(splitRef("localhost:5000/x")).toEqual({
			repo: "localhost:5000/x",
			tag: "latest",
		});
		expect(splitRef("x@sha256:ab").tag).toBe("");
	});
	test("dockerfile: tools as root, base user back, RUN/ENV lines kept", () => {
		const f = dockerfile(
			{ image: "base:1", tools: ["apt-get install -y jq", "ENV A=1"] },
			"paseo",
			"h",
		);
		expect(f).toBe(
			[
				"FROM base:1",
				"USER root",
				'RUN ["/bin/sh","-c","apt-get install -y jq"]',
				"ENV A=1",
				"USER paseo",
				'LABEL mastermind.recipe="h"',
				"",
			].join("\n"),
		);
		expect(() => dockerfile({ image: "b", tools: ["a\nb"] }, "", "h")).toThrow(
			BoxError,
		);
	});
	test("imageHash is stable and uses a given hash", () => {
		expect(imageHash({ image: "a", tools: ["x"] })).toBe(
			imageHash({ image: "a", tools: ["x"] }),
		);
		expect(imageHash({ image: "a" })).not.toBe(imageHash({ image: "b" }));
		expect(imageHash({ image: "a", hash: "given" })).toBe("given");
	});
});

// A fake Docker Engine on a unix socket.
type Req = { method: string; path: string; body: unknown; raw?: Uint8Array };
const dir = mkdtempSync(join(tmpdir(), "mm-docker-"));
const sock = join(dir, "d.sock");
let reqs: Req[] = [];
let images = new Map<string, string>();
let buildError: string | null = null;
let containers = new Map<string, unknown>();
const server = Bun.serve({
	unix: sock,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname.replace(/^\/v1\.41/, "");
		const raw = new Uint8Array(await req.arrayBuffer());
		let body: unknown;
		const isTar = req.headers.get("content-type") === "application/x-tar";
		if (!isTar && raw.length) body = JSON.parse(new TextDecoder().decode(raw));
		reqs.push({
			method: req.method,
			path: `${path}${url.search}`,
			body,
			...(isTar ? { raw } : {}),
		});
		const json = (v: unknown, status = 200) => Response.json(v, { status });
		if (path === "/slow/v1.41/version") await Bun.sleep(500);
		if (path === "/version" || path === "/slow/v1.41/version")
			return json({ Components: [{ Name: "Fake Engine", Version: "9.9" }] });
		const img = path.match(/^\/images\/(.+)\/json$/);
		if (img) {
			const name = decodeURIComponent(img[1] ?? "");
			return images.has(name)
				? json({ Config: { User: images.get(name) } })
				: json({ message: "no such image" }, 404);
		}
		if (path === "/images/create") {
			images.set(
				`${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`,
				"paseo",
			);
			return new Response('{"status":"Pulling"}\n{"status":"Done"}\n');
		}
		if (path === "/build") {
			if (buildError) return new Response(`{"error":"${buildError}"}\n`);
			images.set(url.searchParams.get("t") ?? "", "paseo");
			return new Response('{"stream":"Step 1/5"}\n');
		}
		if (path === "/containers/create") {
			containers.set("c1", body);
			return json({ Id: "c1" }, 201);
		}
		if (/^\/containers\/\w+\/start$/.test(path))
			return new Response(null, { status: 204 });
		if (/^\/containers\/\w+\/exec$/.test(path)) return json({ Id: "e1" });
		if (path === "/exec/e1/start")
			return new Response(
				new Uint8Array([...frame(1, "hello\n"), ...frame(2, "warn\n")]),
			);
		if (path === "/exec/e1/json") return json({ Running: false, ExitCode: 3 });
		if (/^\/containers\/\w+\/archive$/.test(path)) {
			if (req.method === "PUT") return new Response(null, { status: 200 });
			return new Response(tar([{ name: "r.patch", data: "diff" }]));
		}
		if (path === "/containers/json")
			return json([{ Id: "c9", Names: ["/mm-box-x"], Labels: { a: "b" } }]);
		const del = path.match(/^\/containers\/(\w+)$/);
		if (del && req.method === "DELETE") {
			const had = containers.delete(del[1] ?? "");
			return had
				? new Response(null, { status: 204 })
				: json({ message: "no such container" }, 404);
		}
		return json({ message: `unexpected ${req.method} ${path}` }, 500);
	},
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
	reqs = [];
	images = new Map();
	buildError = null;
	containers = new Map();
});
const driver = () =>
	new DockerDriver({ env: { DOCKER_HOST: `unix://${sock}` } });

describe("DockerDriver (fake engine)", () => {
	test("ping names the engine; an unreachable engine gives the fix", async () => {
		expect(await driver().ping()).toBe("Fake Engine 9.9");
		const off = new DockerDriver({
			env: { DOCKER_HOST: `unix://${dir}/none.sock` },
		});
		const err = await off.ping().catch((e) => e);
		expect(err).toBeInstanceOf(BoxError);
		expect(err.message).toContain("--no-box");
	});

	test("an engine that does not answer in time is a BoxError, not a hang", async () => {
		const slow = new DockerDriver({
			endpoint: { base: "http://docker/slow", unix: sock, label: "slow" },
			callTimeoutMs: 50,
		});
		const err = await slow.ping().catch((e) => e);
		expect(err).toBeInstanceOf(BoxError);
		expect(err.message).toContain("did not answer in 0.05 s");
	});

	test("ensureImage pulls the base, builds once, then uses the cache", async () => {
		const d = driver();
		const recipe = {
			image: "ghcr.io/getpaseo/paseo:0.15.4",
			tools: ["apt-get install -y jq"],
			hash: "abc",
		};
		expect(await d.ensureImage(recipe)).toBe("mastermind-box:abc");
		const build = reqs.find((r) => r.path.startsWith("/build"));
		expect(build?.path).toContain("t=mastermind-box%3Aabc");
		const df = new TextDecoder().decode(
			untar(build?.raw ?? new Uint8Array())[0]?.data,
		);
		expect(df).toContain("FROM ghcr.io/getpaseo/paseo:0.15.4");
		expect(df).toContain("USER paseo");
		expect(
			reqs.some((r) =>
				r.path.startsWith(
					"/images/create?fromImage=ghcr.io%2Fgetpaseo%2Fpaseo&tag=0.15.4",
				),
			),
		).toBe(true);
		reqs = [];
		expect(await d.ensureImage(recipe)).toBe("mastermind-box:abc");
		expect(reqs.map((r) => r.method)).toEqual(["GET"]);
	});

	test("no tools: the base image itself", async () => {
		images.set("node:24", "");
		expect(await driver().ensureImage({ image: "node:24" })).toBe("node:24");
		expect(reqs.some((r) => r.path.startsWith("/build"))).toBe(false);
	});

	test("a failing build is a BoxError with the engine's message", async () => {
		images.set("b:1", "");
		buildError = "apt-get: not found";
		const err = await driver()
			.ensureImage({ image: "b:1", tools: ["apt-get x"] })
			.catch((e) => e);
		expect(err).toBeInstanceOf(BoxError);
		expect(err.message).toContain("apt-get: not found");
	});

	test("create: limits, labels, env, network none; then start", async () => {
		const box = await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: { "mastermind.runner": "laptop" },
			limits: { cpu: 1.5, memoryMb: 512 },
			network: "none",
			env: { A: "1" },
			cmd: ["sleep", "infinity"],
		});
		expect(box.id).toBe("c1");
		const create = reqs.find((r) => r.path.startsWith("/containers/create"));
		expect(create?.path).toBe("/containers/create?name=mm-box-1");
		expect(create?.body).toMatchObject({
			Image: "img",
			Cmd: ["sleep", "infinity"],
			Env: ["A=1"],
			Labels: { "mastermind.runner": "laptop" },
			HostConfig: {
				NanoCpus: 1_500_000_000,
				Memory: 512 * 1024 * 1024,
				NetworkMode: "none",
				Init: true,
			},
		});
		expect(reqs.some((r) => r.path === "/containers/c1/start")).toBe(true);
	});

	test("an allow list is refused (not silently open)", async () => {
		const err = await driver()
			.create({
				image: "i",
				name: "n",
				labels: {},
				network: { allow: ["github.com"] },
			})
			.catch((e) => e);
		expect(err.message).toContain("allow lists are not supported");
		expect(reqs.length).toBe(0);
	});

	test("exec, copy in, copy out, destroy (twice is fine)", async () => {
		const box = await driver().create({ image: "i", name: "n", labels: {} });
		const r = await box.exec(["sh", "-c", "x"], {
			env: { K: "v" },
			workdir: "/workspace",
			user: "root",
		});
		expect(r).toEqual({ code: 3, stdout: "hello\n", stderr: "warn\n" });
		expect(
			reqs.find((q) => q.path === "/containers/c1/exec")?.body,
		).toMatchObject({
			Cmd: ["sh", "-c", "x"],
			Env: ["K=v"],
			WorkingDir: "/workspace",
			User: "root",
		});
		await box.copyIn("/run/s", [{ name: "TOKEN", data: "v" }]);
		const put = reqs.find((q) => q.method === "PUT");
		expect(put?.path).toBe("/containers/c1/archive?path=%2Frun%2Fs");
		expect(untar(put?.raw ?? new Uint8Array())[0]?.name).toBe("TOKEN");
		const outTar = await box.copyOut("/tmp/r.patch");
		expect(new TextDecoder().decode(untar(outTar)[0]?.data)).toBe("diff");
		await box.destroy();
		await box.destroy();
		expect(
			reqs.filter((q) => q.method === "DELETE").map((q) => q.path),
		).toEqual(["/containers/c1?force=1&v=1", "/containers/c1?force=1&v=1"]);
	});

	test("list filters by label", async () => {
		const list = await driver().list({ "mastermind.runner": "laptop" });
		expect(list).toEqual([{ id: "c9", name: "mm-box-x", labels: { a: "b" } }]);
		const q = reqs[0]?.path ?? "";
		expect(decodeURIComponent(q)).toContain(
			'{"label":["mastermind.runner=laptop"]}',
		);
	});
});
