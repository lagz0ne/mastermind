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
let networks = new Map<string, unknown>();
let proxyLogs = "mm-proxy listening on 3128\n";
let execExit = 3;
let engineName = "Fake Engine";
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
			return json({ Components: [{ Name: engineName, Version: "9.9" }] });
		if (path === "/info")
			return json({
				Runtimes: {
					runc: { path: "/usr/bin/runc" },
					runsc: { path: "/nowhere/runsc" },
					crun: {},
				},
			});
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
			const id = `c${containers.size + 1}`;
			containers.set(id, body);
			return json({ Id: id }, 201);
		}
		if (path === "/networks/create") {
			networks.set("n1", body);
			return json({ Id: "n1" }, 201);
		}
		if (path === "/networks/n1/connect") return json({});
		const netDel = path.match(/^\/networks\/(\w+)$/);
		if (netDel && req.method === "DELETE")
			return networks.delete(netDel[1] ?? "")
				? new Response(null, { status: 204 })
				: json({ message: "no such network" }, 404);
		const inspect = path.match(/^\/containers\/(\w+)\/json$/);
		if (inspect) {
			const c = containers.get(inspect[1] ?? "") as
				| { Labels?: Record<string, string> }
				| undefined;
			if (!c) return json({ message: "no such container" }, 404);
			return json({
				Config: { Labels: c.Labels },
				State: { Running: true },
				NetworkSettings: {
					Networks: {
						podman: { IPAddress: "10.88.0.5" },
						"mm-box-1-net": { IPAddress: "10.89.0.2", NetworkID: "n1" },
					},
				},
			});
		}
		if (/^\/containers\/\w+\/logs$/.test(path))
			return new Response(frame(1, proxyLogs));
		if (/^\/containers\/\w+\/start$/.test(path))
			return new Response(null, { status: 204 });
		if (/^\/containers\/\w+\/exec$/.test(path)) return json({ Id: "e1" });
		if (path === "/exec/e1/start")
			return new Response(
				new Uint8Array([...frame(1, "hello\n"), ...frame(2, "warn\n")]),
			);
		if (path === "/exec/e1/json")
			return json({ Running: false, ExitCode: execExit });
		if (/^\/containers\/\w+\/archive$/.test(path)) {
			if (req.method === "PUT") return new Response(null, { status: 200 });
			return new Response(tar([{ name: "r.patch", data: "diff" }]));
		}
		if (path === "/containers/json") {
			const f = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
				label?: string[];
			};
			const net = f.label?.find((l) => l.startsWith("mastermind.network="));
			if (!net)
				return json([{ Id: "c9", Names: ["/mm-box-x"], Labels: { a: "b" } }]);
			const id = net.split("=")[1];
			return json(
				[...containers]
					.filter(
						([, c]) =>
							(c as { Labels?: Record<string, string> }).Labels?.[
								"mastermind.network"
							] === id,
					)
					.map(([k]) => ({ Id: k, Names: [`/${k}`], Labels: {} })),
			);
		}
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
	networks = new Map();
	proxyLogs = "mm-proxy listening on 3128\n";
	execExit = 3;
	engineName = "Fake Engine";
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

	test("allow list: internal network, proxy box, task box behind the proxy; destroy deletes all three", async () => {
		const box = await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: { "mastermind.runner": "laptop" },
			network: { allow: ["GitHub.com", "*.npmjs.org:443"] },
			env: { A: "1" },
		});
		const net = reqs.find((r) => r.path === "/networks/create");
		expect(net?.body).toMatchObject({
			Name: "mm-box-1-net",
			Internal: true,
			Labels: { "mastermind.runner": "laptop" },
		});
		const [proxy, task] = reqs.filter((r) =>
			r.path.startsWith("/containers/create"),
		);
		expect(proxy?.path).toBe("/containers/create?name=mm-box-1-proxy");
		const pb = proxy?.body as {
			Env: string[];
			Labels: Record<string, string>;
			HostConfig: Record<string, unknown>;
			User: string;
			Entrypoint: string[];
		};
		expect(pb.Env).toContain("MM_PROXY_ALLOW=github.com,*.npmjs.org:443");
		expect(pb.Labels).toEqual({
			"mastermind.runner": "laptop",
			"mastermind.network": "n1",
			"mastermind.role": "proxy",
		});
		expect(pb.HostConfig.NetworkMode).toBeUndefined();
		expect(pb.HostConfig.CapDrop).toEqual(["ALL"]);
		expect(pb.User).toBe("65534:65534");
		expect(pb.Entrypoint[0]).toBe("/bin/sh");
		expect(reqs.find((r) => r.path === "/networks/n1/connect")?.body).toEqual({
			Container: "c1",
		});
		expect(task?.path).toBe("/containers/create?name=mm-box-1");
		expect(task?.body).toMatchObject({
			Image: "img",
			Labels: { "mastermind.runner": "laptop", "mastermind.network": "n1" },
			HostConfig: { NetworkMode: "n1" },
		});
		const env = (task?.body as { Env: string[] } | undefined)?.Env;
		expect(env).toContain("A=1");
		expect(env).toContain("HTTPS_PROXY=http://10.89.0.2:3128");
		expect(env).toContain("http_proxy=http://10.89.0.2:3128");
		expect(box.id).toBe("c2");
		await box.destroy();
		expect(
			reqs.filter((q) => q.method === "DELETE").map((q) => q.path),
		).toEqual([
			"/containers/c2?force=1&v=1",
			"/containers/c1?force=1&v=1",
			"/networks/n1",
		]);
		expect(containers.size).toBe(0);
		expect(networks.size).toBe(0);
	});

	test("model route, open network: proxy box on the default network holds the credential in a file; the box only the placeholder (mm-210.70)", async () => {
		proxyLogs =
			"mm-proxy listening on 3128\nmm-proxy model on 3129 to api.anthropic.com\n";
		const box = await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: { "mastermind.runner": "laptop" },
			network: "open",
			env: { A: "1" },
			model: {
				secret: "CLAUDE_CODE_OAUTH_TOKEN",
				header: "authorization",
				value: "Bearer SECRET-1",
			},
		});
		expect(reqs.some((r) => r.path === "/networks/create")).toBe(false);
		const [proxy, task] = reqs.filter((r) =>
			r.path.startsWith("/containers/create"),
		);
		expect(proxy?.path).toBe("/containers/create?name=mm-box-1-proxy");
		const pb = proxy?.body as {
			Env: string[];
			HostConfig: Record<string, unknown>;
		};
		expect(pb.Env).toContain("MM_PROXY_ALLOW=");
		const mp = pb.Env.find((e) => e.startsWith("MM_MODEL_PATH="))?.slice(14);
		expect(mp).toMatch(/^[0-9a-f]{36}$/);
		expect(pb.HostConfig.NetworkMode).toBeUndefined();
		// The credential goes into the proxy box as a file, never env or argv.
		const put = reqs.find(
			(r) => r.method === "PUT" && r.path.startsWith("/containers/c1/archive"),
		);
		expect(put?.path).toContain(encodeURIComponent("/tmp"));
		expect(new TextDecoder().decode(put?.raw)).toContain(
			'{"header":"authorization","value":"Bearer SECRET-1"}',
		);
		const bodies = JSON.stringify(reqs.map((r) => [r.path, r.body]));
		expect(bodies).not.toContain("SECRET-1");
		const env = (task?.body as { Env: string[] } | undefined)?.Env ?? [];
		expect(env).toContain("A=1");
		expect(env).toContain(`ANTHROPIC_BASE_URL=http://10.88.0.5:3129/${mp}`);
		expect(env).toContain(
			"CLAUDE_CODE_OAUTH_TOKEN=mastermind-model-proxy-placeholder",
		);
		expect(env.some((e) => e.startsWith("HTTPS_PROXY="))).toBe(false);
		expect(
			(task?.body as { HostConfig: Record<string, unknown> } | undefined)
				?.HostConfig.NetworkMode,
		).toBeUndefined();
		await box.destroy();
		expect(containers.size).toBe(0);
	});

	test("model route, allow list: the same proxy box serves it; the proxy address skips the forward proxy", async () => {
		proxyLogs =
			"mm-proxy listening on 3128\nmm-proxy model on 3129 to api.anthropic.com\n";
		await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: { allow: ["github.com"] },
			model: {
				secret: "ANTHROPIC_API_KEY",
				header: "x-api-key",
				value: "SECRET-2",
			},
		});
		const creates = reqs.filter((r) => r.path.startsWith("/containers/create"));
		expect(creates.length).toBe(2);
		const env = (creates[1]?.body as { Env: string[] } | undefined)?.Env ?? [];
		expect(env).toContain(
			"ANTHROPIC_API_KEY=mastermind-model-proxy-placeholder",
		);
		expect(env.find((e) => e.startsWith("ANTHROPIC_BASE_URL="))).toMatch(
			/^ANTHROPIC_BASE_URL=http:\/\/10\.89\.0\.2:3129\/[0-9a-f]{36}$/,
		);
		expect(env).toContain("NO_PROXY=localhost,127.0.0.1,::1,10.89.0.2");
		expect(JSON.stringify(reqs.map((r) => r.body))).not.toContain("SECRET-2");
	});

	test("model route: waits for the model listener, not only the forward proxy", async () => {
		const d = new DockerDriver({
			env: { DOCKER_HOST: `unix://${sock}` },
			proxyTimeoutMs: 300,
		});
		await expect(
			d.create({
				image: "img",
				name: "mm-box-1",
				labels: {},
				model: { secret: "ANTHROPIC_API_KEY", header: "x-api-key", value: "S" },
			}),
		).rejects.toThrow("not ready");
		expect(containers.size).toBe(0);
	});

	test("model route, network none: no proxy, no credential, no placeholder", async () => {
		await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: "none",
			model: { secret: "ANTHROPIC_API_KEY", header: "x-api-key", value: "S" },
		});
		const creates = reqs.filter((r) => r.path.startsWith("/containers/create"));
		expect(creates.length).toBe(1);
		const env = (creates[0]?.body as { Env: string[] } | undefined)?.Env ?? [];
		expect(env.some((e) => e.startsWith("ANTHROPIC"))).toBe(false);
	});

	test("runtimes: from /info; on a local Podman socket only installed ones (mm-210.63)", async () => {
		expect(await driver().runtimes()).toEqual(["crun", "runc", "runsc"]);
		engineName = "Podman Engine";
		const podman = new DockerDriver({
			env: { DOCKER_HOST: `unix://${sock}` },
			exists: (p) => p === "/usr/bin/runc",
		});
		expect(await podman.runtimes()).toEqual(["crun", "runc"]);
	});

	test("runtime: the task box gets HostConfig.Runtime, the proxy box does not", async () => {
		await driver().create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: { allow: ["github.com"] },
			runtime: "runsc",
		});
		const [proxy, task] = reqs.filter((r) =>
			r.path.startsWith("/containers/create"),
		);
		const hc = (r: Req | undefined) =>
			(r?.body as { HostConfig: Record<string, unknown> } | undefined)
				?.HostConfig ?? {};
		expect(hc(proxy).Runtime).toBeUndefined();
		expect(hc(task).Runtime).toBe("runsc");
	});

	test("setAllow: writes the rules in the proxy box as nobody and waits for its ack", async () => {
		const d = new DockerDriver({
			env: { DOCKER_HOST: `unix://${sock}` },
			proxyTimeoutMs: 500,
		});
		const box = await d.create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: { allow: ["*.npmjs.org", "github.com"] },
		});
		execExit = 0;
		reqs = [];
		proxyLogs += "mm-proxy allow 1: github.com (closed 2)\n";
		await box.setAllow?.(["GitHub.com"]);
		const ex = reqs.find((r) => r.path === "/containers/c1/exec");
		const b = ex?.body as { Cmd: string[]; User: string };
		expect(b.User).toBe("65534:65534");
		expect(b.Cmd.slice(-3)).toEqual(["1", "github.com", "/tmp/mm-proxy-allow"]);
		// generation 2 never acknowledged: a BoxError, not a hang
		await expect(box.setAllow?.(["github.com"])).rejects.toThrow(
			"did not apply the new allow list",
		);
		// a bad entry: refused before the proxy is touched
		reqs = [];
		await expect(box.setAllow?.(["https://x"])).rejects.toThrow(
			"is not a host",
		);
		expect(reqs).toHaveLength(0);
	});

	test("allow list: a bad entry is refused before anything is made", async () => {
		const err = await driver()
			.create({
				image: "i",
				name: "n",
				labels: {},
				network: { allow: ["https://github.com"] },
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(BoxError);
		expect(err.message).toContain("is not a host");
		expect(reqs.length).toBe(0);
	});

	test("allow list: a proxy that never listens is a BoxError and nothing is left", async () => {
		proxyLogs = "mm-proxy: the proxy image has neither node nor bun\n";
		const d = new DockerDriver({
			env: { DOCKER_HOST: `unix://${sock}` },
			proxyTimeoutMs: 200,
		});
		const err = await d
			.create({
				image: "i",
				name: "mm-box-1",
				labels: {},
				network: { allow: ["github.com"] },
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(BoxError);
		expect(err.message).toContain("neither node nor bun");
		expect(containers.size).toBe(0);
		expect(networks.size).toBe(0);
	});

	test("allow list: MM_BOX_PROXY_IMAGE runs the proxy from its own image", async () => {
		images.set("node:24-alpine", "node");
		await new DockerDriver({
			env: {
				DOCKER_HOST: `unix://${sock}`,
				MM_BOX_PROXY_IMAGE: "node:24-alpine",
			},
		}).create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: { allow: ["github.com"] },
		});
		const [proxy, task] = reqs.filter((r) =>
			r.path.startsWith("/containers/create"),
		);
		expect(proxy?.body).toMatchObject({ Image: "node:24-alpine" });
		expect(task?.body).toMatchObject({ Image: "img" });
	});

	test("remove (the sweep) of an allow-list box also deletes its network once unused", async () => {
		const d = driver();
		await d.create({
			image: "img",
			name: "mm-box-1",
			labels: {},
			network: { allow: ["github.com"] },
		});
		reqs = [];
		await d.remove("c2");
		await d.remove("c1");
		await d.remove("c1");
		expect(
			reqs.filter((q) => q.method === "DELETE").map((q) => q.path),
		).toEqual([
			"/containers/c2?force=1&v=1",
			"/containers/c1?force=1&v=1",
			"/networks/n1",
		]);
		expect(networks.size).toBe(0);
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
