/**
 * Box driver over the Docker Engine HTTP API (Bun fetch, unix socket or TCP).
 * Podman's Docker-compatible socket works too.
 *
 * Endpoint: $DOCKER_HOST (unix:///path or tcp://host:port), else
 * /var/run/docker.sock, else $XDG_RUNTIME_DIR/podman/podman.sock.
 */
import { existsSync } from "node:fs";
import {
	type Box,
	type BoxDriver,
	BoxError,
	type BoxInfo,
	type BoxSpec,
	type ExecOptions,
	type ExecResult,
	type ImageRecipe,
	imageHash,
} from "./driver.ts";
import {
	MODEL_AUTH_FILE,
	MODEL_READY,
	type ModelAuth,
	modelEnv,
	modelPath,
	modelProxyEnv,
	PROXY_JS,
	PROXY_READY,
	PROXY_RULES,
	PROXY_SH,
	parseAllow,
	proxyAllowLine,
	proxyEnv,
} from "./proxy.ts";
import { tar, tarStream, untarFirst } from "./tar.ts";

/** A streamed file copy into or out of a box may take this long. */
const STREAM_MS = 10 * 60_000;

const API = "/v1.41";
/** Most output kept per exec stream. */
const MAX_OUTPUT = 4 * 1024 * 1024;
/** On the boxes of an allow list: the id of their internal network. */
export const NETWORK_LABEL = "mastermind.network";
/** On the proxy box of an allow list: `proxy`. */
export const ROLE_LABEL = "mastermind.role";

export type DockerEndpoint = { base: string; unix?: string; label: string };

/** Where the engine is, from DOCKER_HOST or the default sockets. */
export function dockerEndpoint(
	env: Record<string, string | undefined> = process.env,
	exists: (p: string) => boolean = existsSync,
): DockerEndpoint {
	const host = env.DOCKER_HOST?.trim();
	if (host) {
		if (host.startsWith("unix://")) {
			const path = host.slice("unix://".length);
			return { base: "http://docker", unix: path, label: host };
		}
		if (host.startsWith("tcp://") || host.startsWith("http://"))
			return {
				base: `http://${host.replace(/^\w+:\/\//, "")}`,
				label: host,
			};
		throw new BoxError(
			`DOCKER_HOST=${host} is not supported (use unix:// or tcp://)`,
		);
	}
	const podman = env.XDG_RUNTIME_DIR
		? `${env.XDG_RUNTIME_DIR}/podman/podman.sock`
		: null;
	const path =
		!exists("/var/run/docker.sock") && podman && exists(podman)
			? podman
			: "/var/run/docker.sock";
	return { base: "http://docker", unix: path, label: `unix://${path}` };
}

/** Split Docker's multiplexed stdout/stderr stream (non-TTY exec and logs). */
export class Demux {
	readonly #out: Uint8Array[] = [];
	readonly #err: Uint8Array[] = [];
	#outLen = 0;
	#errLen = 0;
	#buf = new Uint8Array(0);

	push(chunk: Uint8Array): void {
		const b = new Uint8Array(this.#buf.length + chunk.length);
		b.set(this.#buf);
		b.set(chunk, this.#buf.length);
		let at = 0;
		while (b.length - at >= 8) {
			const size =
				((b[at + 4] ?? 0) << 24) |
				((b[at + 5] ?? 0) << 16) |
				((b[at + 6] ?? 0) << 8) |
				(b[at + 7] ?? 0);
			if (b.length - at - 8 < size) break;
			const frame = b.slice(at + 8, at + 8 + size);
			if (b[at] === 2) this.#errLen = keep(this.#err, frame, this.#errLen);
			else this.#outLen = keep(this.#out, frame, this.#outLen);
			at += 8 + size;
		}
		this.#buf = b.slice(at);
	}

	get stdout(): string {
		return text(this.#out);
	}
	get stderr(): string {
		return text(this.#err);
	}
}

/** Append, dropping the oldest frames over MAX_OUTPUT. */
function keep(list: Uint8Array[], frame: Uint8Array, len: number): number {
	list.push(frame);
	len += frame.length;
	while (len > MAX_OUTPUT && list.length > 1) len -= list.shift()?.length ?? 0;
	return len;
}

function text(list: Uint8Array[]): string {
	return Buffer.concat(list).toString("utf8");
}

/** Repository and tag of an image reference (`fromImage` + `tag` for a pull). */
export function splitRef(ref: string): { repo: string; tag: string } {
	if (ref.includes("@")) return { repo: ref, tag: "" };
	const slash = ref.lastIndexOf("/");
	const colon = ref.lastIndexOf(":");
	return colon > slash
		? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) }
		: { repo: ref, tag: "latest" };
}

/** The Dockerfile of a box image: base + tools as root, then the base user again. */
export function dockerfile(
	recipe: ImageRecipe,
	baseUser: string,
	hash: string,
): string {
	const lines = [`FROM ${recipe.image}`, "USER root"];
	for (const t of recipe.tools ?? []) {
		if (/[\r\n]/.test(t)) throw new BoxError(`tool line has a newline: ${t}`);
		// A line may be a RUN or ENV instruction itself, or else a shell command.
		lines.push(
			/^(RUN|ENV)\s/.test(t)
				? t
				: `RUN ${JSON.stringify(["/bin/sh", "-c", t])}`,
		);
	}
	lines.push(`USER ${baseUser || "root"}`);
	lines.push(`LABEL mastermind.recipe=${JSON.stringify(hash)}`);
	return `${lines.join("\n")}\n`;
}

export type DockerDriverOptions = {
	env?: Record<string, string | undefined>;
	endpoint?: DockerEndpoint;
	/** Repository of built box images. Default `mastermind-box`. */
	repository?: string;
	log?: (line: string) => void;
	/** Longest wait for one engine call. Default 60 s. */
	callTimeoutMs?: number;
	/** Longest pull or build. Default 30 min. */
	imageTimeoutMs?: number;
	/**
	 * Image of the egress proxy box of an allow list; it needs node or bun.
	 * Default: $MM_BOX_PROXY_IMAGE, else the task box's own image.
	 */
	proxyImage?: string;
	/** Longest wait for the proxy box to listen. Default 30 s. */
	proxyTimeoutMs?: number;
	/** For tests: does a host path exist (Podman runtime binaries). */
	exists?: (path: string) => boolean;
};

export class DockerDriver implements BoxDriver {
	readonly #ep: DockerEndpoint;
	readonly #repo: string;
	readonly #log: (line: string) => void;
	readonly #callMs: number;
	readonly #imageMs: number;
	readonly #proxyImage: string | undefined;
	readonly #proxyMs: number;
	readonly #exists: (path: string) => boolean;
	#podman: Promise<boolean> | undefined;
	/** One build per image at a time. */
	readonly #building = new Map<string, Promise<string>>();

	constructor(opts: DockerDriverOptions = {}) {
		this.#ep = opts.endpoint ?? dockerEndpoint(opts.env);
		this.#repo = opts.repository ?? "mastermind-box";
		this.#log = opts.log ?? (() => {});
		this.#callMs = opts.callTimeoutMs ?? 60_000;
		this.#imageMs = opts.imageTimeoutMs ?? 30 * 60_000;
		this.#proxyImage =
			opts.proxyImage ??
			((opts.env ?? process.env).MM_BOX_PROXY_IMAGE?.trim() || undefined);
		this.#proxyMs = opts.proxyTimeoutMs ?? 30_000;
		this.#exists = opts.exists ?? existsSync;
	}

	get name(): string {
		return `docker ${this.#ep.label}`;
	}

	async #fetch(
		method: string,
		path: string,
		init: {
			body?: unknown;
			raw?: Uint8Array;
			/** A tar archive that streams (files, mm-210.60). */
			stream?: ReadableStream<Uint8Array>;
			signal?: AbortSignal;
			ok404?: boolean;
			/** Default: the call timeout. null: none (exec output, bounded by the box). */
			timeoutMs?: number | null;
			/** A full API path (Podman's /v4.0.0/libpod/...), not under /v1.41. */
			absolute?: boolean;
		} = {},
	): Promise<Response> {
		// The rootless Podman lock is shared: never wait for the engine forever.
		const ms = init.timeoutMs === undefined ? this.#callMs : init.timeoutMs;
		const timer = ms === null ? undefined : AbortSignal.timeout(ms);
		const signals = [init.signal, timer].filter(
			(x): x is AbortSignal => x !== undefined,
		);
		const signal = signals.length ? AbortSignal.any(signals) : undefined;
		const headers: Record<string, string> = {};
		let body: Uint8Array | string | ReadableStream<Uint8Array> | undefined;
		if (init.raw || init.stream) {
			headers["content-type"] = "application/x-tar";
			body = init.raw ?? init.stream;
		} else if (init.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.body);
		}
		let res: Response;
		try {
			res = await fetch(`${this.#ep.base}${init.absolute ? "" : API}${path}`, {
				method,
				headers,
				body,
				signal,
				...(init.stream ? { duplex: "half" } : {}),
				...(this.#ep.unix ? { unix: this.#ep.unix } : {}),
			} as RequestInit);
		} catch (error) {
			if (init.signal?.aborted) throw new BoxError("stopped");
			if (timer?.aborted)
				throw new BoxError(
					`${method} ${path.split("?")[0]}: the box engine did not answer in ${(ms ?? 0) / 1000} s`,
				);
			throw new BoxError(
				`cannot reach the box engine at ${this.#ep.label}: ${error instanceof Error ? error.message : error}`,
			);
		}
		if (res.ok || (init.ok404 && res.status === 404)) return res;
		const t = await res.text().catch(() => "");
		let msg = t;
		try {
			msg = (JSON.parse(t) as { message?: string }).message ?? t;
		} catch {}
		throw new BoxError(
			`${method} ${path.split("?")[0]}: ${res.status} ${msg.trim().slice(0, 300)}`,
		);
	}

	async ping(): Promise<string> {
		try {
			const res = await this.#fetch("GET", "/version");
			const v = (await res.json()) as {
				Version?: string;
				Components?: { Name: string; Version: string }[];
			};
			const c = v.Components?.[0];
			return c ? `${c.Name} ${c.Version}` : `Docker ${v.Version ?? "?"}`;
		} catch (error) {
			throw new BoxError(
				`${error instanceof Error ? error.message : error}; fix: start Docker, or set DOCKER_HOST (Podman: podman system service --time=0 unix://<path>), or start the runner with --no-box at your own risk`,
			);
		}
	}

	/**
	 * Runtimes from GET /info. Podman lists every runtime of containers.conf,
	 * also the ones that are not installed: on a local socket only those whose
	 * binary exists count.
	 */
	async runtimes(): Promise<string[]> {
		const info = (await (await this.#fetch("GET", "/info")).json()) as {
			Runtimes?: Record<string, { path?: string }>;
		};
		const all = Object.entries(info.Runtimes ?? {});
		const local = this.#ep.unix !== undefined && (await this.#isPodman());
		return all
			.filter(([, r]) => !local || !r.path || this.#exists(r.path))
			.map(([name]) => name)
			.sort();
	}

	async #imageUser(ref: string): Promise<string | null> {
		const res = await this.#fetch(
			"GET",
			`/images/${encodeURIComponent(ref)}/json`,
			{ ok404: true },
		);
		if (res.status === 404) return null;
		const info = (await res.json()) as { Config?: { User?: string } };
		return info.Config?.User ?? "";
	}

	/** Read a JSON-lines progress stream (pull, build); throw on its error. */
	async #progress(res: Response, what: string): Promise<void> {
		const lines = (await res.text()).split("\n").filter(Boolean);
		const tail: string[] = [];
		for (const l of lines) {
			let m: { error?: string; stream?: string; status?: string };
			try {
				m = JSON.parse(l);
			} catch {
				continue;
			}
			if (m.error) throw new BoxError(`${what}: ${m.error}\n${tail.join("")}`);
			if (m.stream) tail.push(m.stream);
			if (tail.length > 20) tail.shift();
		}
	}

	async #pull(ref: string): Promise<void> {
		const { repo, tag } = splitRef(ref);
		this.#log(`box: pulling ${ref}`);
		const q = new URLSearchParams({ fromImage: repo, ...(tag ? { tag } : {}) });
		const res = await this.#fetch("POST", `/images/create?${q}`, {
			timeoutMs: this.#imageMs,
		});
		await this.#progress(res, `pull ${ref}`);
		if ((await this.#imageUser(ref)) === null)
			throw new BoxError(`pull ${ref}: image is still missing`);
	}

	ensureImage(recipe: ImageRecipe): Promise<string> {
		const key = imageHash(recipe);
		const running = this.#building.get(key);
		if (running) return running;
		const p = this.#ensure(recipe, key).finally(() =>
			this.#building.delete(key),
		);
		this.#building.set(key, p);
		return p;
	}

	async #ensure(recipe: ImageRecipe, hash: string): Promise<string> {
		const tools = recipe.tools ?? [];
		const tagged = `${this.#repo}:${hash}`;
		if (tools.length > 0 && (await this.#imageUser(tagged)) !== null)
			return tagged;
		let user = await this.#imageUser(recipe.image);
		if (user === null) {
			await this.#pull(recipe.image);
			user = (await this.#imageUser(recipe.image)) ?? "";
		}
		if (tools.length === 0) return recipe.image;
		this.#log(`box: building ${tagged} (${tools.length} tools)`);
		const context = tar([
			{ name: "Dockerfile", data: dockerfile(recipe, user, hash) },
		]);
		const q = new URLSearchParams({ t: tagged, rm: "1", forcerm: "1" });
		const res = await this.#fetch("POST", `/build?${q}`, {
			raw: context,
			timeoutMs: this.#imageMs,
		});
		await this.#progress(res, `build ${tagged}`);
		if ((await this.#imageUser(tagged)) === null)
			throw new BoxError(`build ${tagged}: image is missing after the build`);
		return tagged;
	}

	async create(spec: BoxSpec): Promise<Box> {
		const net = spec.network ?? "open";
		if (typeof net === "object") return this.#createAllow(spec, net.allow);
		if (net === "open" && spec.model) return this.#createOpenModel(spec);
		const id = await this.#run(spec, net === "none" ? "none" : undefined);
		return new DockerBox(this, id, spec.name);
	}

	/**
	 * Start the proxy box of a box (allow list and/or model route). With a
	 * model credential: the route's random path in its env, the credential in
	 * {@link MODEL_AUTH_FILE} (copied in, never env or argv).
	 */
	async #startProxy(
		spec: BoxSpec,
		labels: Record<string, string>,
		allow: string[],
		path: string | undefined,
	): Promise<string> {
		const proxyImage = this.#proxyImage
			? await this.ensureImage({ image: this.#proxyImage })
			: spec.image;
		const id = await this.#run(
			{
				image: proxyImage,
				name: `${spec.name}-proxy`,
				labels: { ...labels, [ROLE_LABEL]: "proxy" },
				limits: { cpu: 0.5, memoryMb: 256 },
				cmd: [],
				env: {
					MM_PROXY_JS: PROXY_JS,
					MM_PROXY_ALLOW: allow.join(","),
					...(path ? modelProxyEnv(path) : {}),
				},
			},
			undefined,
			{
				entrypoint: ["/bin/sh", "-c", PROXY_SH],
				user: "65534:65534",
				capDropAll: true,
			},
		);
		if (spec.model) {
			const slash = MODEL_AUTH_FILE.lastIndexOf("/");
			try {
				await new DockerBox(this, id, "proxy").copyIn(
					MODEL_AUTH_FILE.slice(0, slash),
					[
						{
							name: MODEL_AUTH_FILE.slice(slash + 1),
							data: JSON.stringify(modelAuthFile(spec.model)),
							mode: 0o444,
						},
					],
				);
			} catch (error) {
				await this.#delete(id).catch(() => {});
				throw error;
			}
		}
		return id;
	}

	/**
	 * Open network with a model credential: a proxy box on the default network
	 * that only serves the model route (its forward proxy allows nothing); the
	 * task box stays on the default network with its own route out.
	 */
	async #createOpenModel(spec: BoxSpec): Promise<Box> {
		const path = modelPath();
		const proxy = await this.#startProxy(spec, spec.labels, [], path);
		try {
			const ip = await this.#proxyReady(proxy, null, true);
			this.#log(`box: ${spec.name}-proxy serves the model route (${ip})`);
			const id = await this.#run({
				...spec,
				env: { ...spec.env, ...modelEnv(ip, path, model(spec)) },
			});
			return new DockerBox(this, id, spec.name, [proxy]);
		} catch (error) {
			await this.#delete(proxy).catch(() => {});
			throw error;
		}
	}

	/** Create and start one container; delete it again when the start fails. */
	async #run(
		spec: BoxSpec,
		networkMode?: string,
		more: { entrypoint?: string[]; user?: string; capDropAll?: boolean } = {},
	): Promise<string> {
		const host: Record<string, unknown> = {
			Init: true,
			SecurityOpt: ["no-new-privileges"],
		};
		if (spec.limits?.cpu) host.NanoCpus = Math.round(spec.limits.cpu * 1e9);
		if (spec.limits?.memoryMb) host.Memory = spec.limits.memoryMb * 1024 * 1024;
		if (networkMode) host.NetworkMode = networkMode;
		if (more.capDropAll) host.CapDrop = ["ALL"];
		if (spec.runtime) host.Runtime = spec.runtime;
		// Z: relabel for this box on SELinux hosts (ignored elsewhere).
		if (spec.mounts?.length)
			host.Binds = spec.mounts.map((m) => `${m.source}:${m.target}:Z`);
		const res = await this.#fetch(
			"POST",
			`/containers/create?name=${encodeURIComponent(spec.name)}`,
			{
				body: {
					Image: spec.image,
					...(more.entrypoint ? { Entrypoint: more.entrypoint } : {}),
					...(spec.cmd ? { Cmd: spec.cmd } : {}),
					...(more.user ? { User: more.user } : {}),
					Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
					Labels: spec.labels,
					HostConfig: host,
				},
			},
		);
		const { Id } = (await res.json()) as { Id: string };
		try {
			await this.#fetch("POST", `/containers/${Id}/start`);
		} catch (error) {
			await this.#delete(Id).catch(() => {});
			throw error;
		}
		return Id;
	}

	/**
	 * Allow list: an internal network (no route out) for the task box, and a
	 * proxy box on it and on the default network that only connects to the
	 * allowed hosts. The task box gets HTTP(S)_PROXY. All three carry the
	 * box labels, so destroy and the sweep delete them together.
	 */
	async #createAllow(spec: BoxSpec, allowIn: string[]): Promise<Box> {
		const allow = parseAllow(allowIn);
		if (typeof allow === "string") throw new BoxError(allow);
		const made: { net?: string; proxy?: string } = {};
		try {
			const netName = `${spec.name}-net`;
			const netId = await this.#internalNetwork(netName, spec.labels);
			made.net = netId;
			const labels = { ...spec.labels, [NETWORK_LABEL]: netId };
			const path = spec.model ? modelPath() : undefined;
			made.proxy = await this.#startProxy(spec, labels, allow, path);
			await this.#fetch("POST", `/networks/${netId}/connect`, {
				body: { Container: made.proxy },
			});
			const ip = await this.#proxyReady(
				made.proxy,
				{ name: netName, id: netId },
				!!path,
			);
			this.#log(
				`box: ${spec.name}-proxy allows ${allow.join(", ")}${path ? " and serves the model route" : ""} (${ip})`,
			);
			const id = await this.#run(
				{
					...spec,
					labels,
					env: {
						...spec.env,
						...proxyEnv(ip, path ? [ip] : []),
						...(path ? modelEnv(ip, path, model(spec)) : {}),
					},
				},
				netId,
			);
			return new DockerBox(this, id, spec.name, [made.proxy], netId);
		} catch (error) {
			if (made.proxy) await this.#delete(made.proxy).catch(() => {});
			if (made.net) await this.#deleteNetwork(made.net);
			throw error;
		}
	}

	/**
	 * @internal for DockerBox: write allow list generation `gen` into the rules
	 * file of the proxy box, then wait until the proxy logs that it applied it.
	 */
	async setProxyAllow(
		proxy: string,
		allowIn: string[],
		gen: number,
	): Promise<void> {
		const allow = parseAllow(allowIn);
		if (typeof allow === "string") throw new BoxError(allow);
		const w = await new DockerBox(this, proxy, "proxy").exec(
			[
				"/bin/sh",
				"-c",
				'printf "%s\\n%s" "$1" "$2" > "$3.new" && mv -f "$3.new" "$3"',
				"rules",
				String(gen),
				allow.join(","),
				PROXY_RULES,
			],
			{ user: "65534:65534", workdir: "/" },
		);
		if (w.code !== 0)
			throw new BoxError(
				`network phase: cannot write the proxy rules: ${`${w.stdout}${w.stderr}`.trim().slice(-300)}`,
			);
		const line = proxyAllowLine(gen);
		const until = Date.now() + this.#proxyMs;
		for (;;) {
			const logs = await this.logsOf(proxy, 200);
			if (logs.includes(line)) return;
			if (Date.now() > until)
				throw new BoxError(
					`network phase: the proxy did not apply the new allow list in ${this.#proxyMs / 1000} s: ${logs.trim().slice(-300)}`,
				);
			await Bun.sleep(100);
		}
	}

	/** Is the engine Podman? (Asked once.) */
	#isPodman(): Promise<boolean> {
		this.#podman ??= this.#fetch("GET", "/version")
			.then((r) => r.json() as Promise<{ Components?: { Name?: string }[] }>)
			.then((v) =>
				(v.Components ?? []).some((c) => /podman/i.test(c.Name ?? "")),
			)
			.catch(() => false);
		return this.#podman;
	}

	/**
	 * An internal network (no route out). On Podman without DNS: the proxy is
	 * reached by address, and aardvark-dns needs a user D-Bus that a runner
	 * service may not have.
	 */
	async #internalNetwork(
		name: string,
		labels: Record<string, string>,
	): Promise<string> {
		if (await this.#isPodman()) {
			const res = await this.#fetch("POST", "/v4.0.0/libpod/networks/create", {
				absolute: true,
				body: { name, internal: true, dns_enabled: false, labels },
			});
			return ((await res.json()) as { id: string }).id;
		}
		const res = await this.#fetch("POST", "/networks/create", {
			body: {
				Name: name,
				Internal: true,
				CheckDuplicate: true,
				Labels: labels,
			},
		});
		return ((await res.json()) as { Id: string }).Id;
	}

	/**
	 * Wait until the proxy listens (and its model route, with `model`); its
	 * address on network `net`, else on its first network.
	 */
	async #proxyReady(
		id: string,
		net: { name: string; id: string } | null,
		model = false,
	): Promise<string> {
		const until = Date.now() + this.#proxyMs;
		for (;;) {
			const info = (await (
				await this.#fetch("GET", `/containers/${id}/json`)
			).json()) as {
				State?: { Running?: boolean };
				NetworkSettings?: {
					IPAddress?: string;
					Networks?: Record<string, { IPAddress?: string; NetworkID?: string }>;
				};
			};
			const logs = await this.logsOf(id, 50);
			if (!info.State?.Running)
				throw new BoxError(
					`box proxy: the proxy box stopped: ${logs.trim().slice(-500)}`,
				);
			const nets = info.NetworkSettings?.Networks ?? {};
			const ip = net
				? nets[net.name]?.IPAddress ||
					Object.values(nets).find((n) => n.NetworkID === net.id)?.IPAddress
				: Object.values(nets).find((n) => n.IPAddress)?.IPAddress ||
					info.NetworkSettings?.IPAddress;
			const ready =
				logs.includes(PROXY_READY) && (!model || logs.includes(MODEL_READY));
			if (ip && ready) return ip;
			if (Date.now() > until)
				throw new BoxError(
					`box proxy: the proxy box is not ready after ${this.#proxyMs / 1000} s (address ${ip || "none"}): ${logs.trim().slice(-500)}`,
				);
			await Bun.sleep(100);
		}
	}

	/** @internal the tail of a container's output */
	async logsOf(id: string, tail: number): Promise<string> {
		const res = await this.#fetch(
			"GET",
			`/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`,
		);
		const d = await demux(res);
		return `${d.stdout}${d.stderr}`;
	}

	async #delete(id: string): Promise<void> {
		await this.#fetch("DELETE", `/containers/${id}?force=1&v=1`, {
			ok404: true,
		});
	}

	/** Delete a network; quiet when it is gone or still in use. */
	async #deleteNetwork(id: string): Promise<void> {
		await this.#fetch("DELETE", `/networks/${id}`, { ok404: true }).catch(
			() => {},
		);
	}

	/** @internal for DockerBox: the box, its proxy boxes, then its network. */
	async destroyAll(
		id: string,
		extra: readonly string[],
		net?: string,
	): Promise<void> {
		await this.#delete(id);
		for (const x of extra) await this.#delete(x);
		if (net) await this.#deleteNetwork(net);
	}

	async list(labels: Record<string, string>): Promise<BoxInfo[]> {
		const filters = JSON.stringify({
			label: Object.entries(labels).map(([k, v]) => `${k}=${v}`),
		});
		const res = await this.#fetch(
			"GET",
			`/containers/json?all=1&filters=${encodeURIComponent(filters)}`,
		);
		const list = (await res.json()) as {
			Id: string;
			Names?: string[];
			Labels?: Record<string, string>;
		}[];
		return list.map((c) => ({
			id: c.Id,
			name: (c.Names?.[0] ?? "").replace(/^\//, ""),
			labels: c.Labels ?? {},
		}));
	}

	async remove(id: string): Promise<void> {
		const res = await this.#fetch("GET", `/containers/${id}/json`, {
			ok404: true,
		});
		if (res.status === 404) return;
		const info = (await res.json()) as {
			Config?: { Labels?: Record<string, string> };
		};
		await this.#delete(id);
		// The last box of an allow-list network deletes it. (Podman deletes a
		// network that is still in use, which breaks the delete of the rest.)
		const net = info.Config?.Labels?.[NETWORK_LABEL];
		if (net && (await this.list({ [NETWORK_LABEL]: net })).length === 0)
			await this.#deleteNetwork(net);
	}

	/**
	 * Empty `source` as root in a short box (no network, all caps dropped but
	 * the ones rm needs over files of other users).
	 */
	async wipe(source: string, image: string): Promise<void> {
		const res = await this.#fetch(
			"POST",
			`/containers/create?name=${encodeURIComponent(`mm-wipe-${crypto.randomUUID().slice(0, 8)}`)}`,
			{
				body: {
					Image: image,
					Entrypoint: ["/bin/sh", "-c"],
					Cmd: [
						'chmod -R u+rwX /w 2>/dev/null; rm -rf /w/* /w/.[!.]* /w/..?*; test -z "$(ls -A /w)"',
					],
					User: "0:0",
					HostConfig: {
						Binds: [`${source}:/w:Z`],
						NetworkMode: "none",
						SecurityOpt: ["no-new-privileges"],
						CapDrop: ["ALL"],
						CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
					},
				},
			},
		);
		const { Id } = (await res.json()) as { Id: string };
		try {
			await this.#fetch("POST", `/containers/${Id}/start`);
			const w = (await (
				await this.#fetch("POST", `/containers/${Id}/wait`, {
					timeoutMs: 120_000,
				})
			).json()) as { StatusCode?: number };
			if (w.StatusCode !== 0)
				throw new BoxError(
					`wipe ${source}: exited ${w.StatusCode}: ${(await this.logsOf(Id, 5).catch(() => "")).trim()}`,
				);
		} finally {
			await this.#delete(Id).catch(() => {});
		}
	}

	/** @internal for DockerBox */
	request(
		method: string,
		path: string,
		init?: {
			body?: unknown;
			raw?: Uint8Array;
			stream?: ReadableStream<Uint8Array>;
			signal?: AbortSignal;
			ok404?: boolean;
			timeoutMs?: number | null;
		},
	): Promise<Response> {
		return this.#fetch(method, path, init);
	}
}

function model(spec: BoxSpec): ModelAuth {
	if (!spec.model) throw new BoxError("box proxy: no model credential");
	return spec.model;
}

/** The content of {@link MODEL_AUTH_FILE}: the header only, not the secret name. */
function modelAuthFile(m: ModelAuth): { header: string; value: string } {
	return { header: m.header, value: m.value };
}

async function demux(res: Response): Promise<Demux> {
	const d = new Demux();
	if (!res.body) return d;
	for await (const chunk of res.body) d.push(chunk);
	return d;
}

class DockerBox implements Box {
	constructor(
		readonly driver: DockerDriver,
		readonly id: string,
		readonly name: string,
		/** The proxy box of an allow list. */
		readonly extra: readonly string[] = [],
		/** The internal network of an allow list. */
		readonly network?: string,
	) {}

	async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
		const d = this.driver;
		const created = await d.request("POST", `/containers/${this.id}/exec`, {
			body: {
				AttachStdin: false,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: cmd,
				Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
				...(opts.workdir ? { WorkingDir: opts.workdir } : {}),
				...(opts.user ? { User: opts.user } : {}),
			},
			signal: opts.signal,
		});
		const { Id } = (await created.json()) as { Id: string };
		let out: Demux;
		try {
			const res = await d.request("POST", `/exec/${Id}/start`, {
				timeoutMs: null,
				body: { Detach: false, Tty: false },
				signal: opts.signal,
			});
			out = await demux(res);
		} catch (error) {
			if (opts.signal?.aborted) throw new BoxError("stopped");
			throw error;
		}
		// The exit code can lag the end of the stream by a moment.
		for (let i = 0; i < 50; i++) {
			const info = (await (
				await d.request("GET", `/exec/${Id}/json`)
			).json()) as { Running?: boolean; ExitCode?: number | null };
			if (!info.Running && typeof info.ExitCode === "number")
				return { code: info.ExitCode, stdout: out.stdout, stderr: out.stderr };
			await Bun.sleep(100);
		}
		throw new BoxError(`exec ${cmd[0]}: no exit code`);
	}

	async copyIn(
		dir: string,
		files: { name: string; data: string | Uint8Array; mode?: number }[],
	): Promise<void> {
		await this.driver.request(
			"PUT",
			`/containers/${this.id}/archive?path=${encodeURIComponent(dir)}`,
			{ raw: tar(files) },
		);
	}

	async copyInStream(
		dir: string,
		file: {
			name: string;
			size: number;
			data: ReadableStream<Uint8Array>;
			mode?: number;
		},
	): Promise<void> {
		await this.driver.request(
			"PUT",
			`/containers/${this.id}/archive?path=${encodeURIComponent(dir)}`,
			{ stream: tarStream(file), timeoutMs: STREAM_MS },
		);
	}

	async copyOutStream(
		path: string,
	): Promise<{ size: number; data: ReadableStream<Uint8Array> } | null> {
		const res = await this.driver.request(
			"GET",
			`/containers/${this.id}/archive?path=${encodeURIComponent(path)}`,
			{ ok404: true, timeoutMs: STREAM_MS },
		);
		if (res.status === 404 || !res.body) return null;
		const f = await untarFirst(res.body);
		return f ? { size: f.size, data: f.data } : null;
	}

	async copyOut(path: string): Promise<Uint8Array> {
		const res = await this.driver.request(
			"GET",
			`/containers/${this.id}/archive?path=${encodeURIComponent(path)}`,
		);
		return new Uint8Array(await res.arrayBuffer());
	}

	logs(tail = 100): Promise<string> {
		return this.driver.logsOf(this.id, tail);
	}

	#gen = 0;
	async setAllow(allow: string[]): Promise<void> {
		const proxy = this.extra[0];
		if (!proxy)
			throw new BoxError(
				"network phase: this box has no allow list (no proxy box)",
			);
		await this.driver.setProxyAllow(proxy, allow, ++this.#gen);
	}

	destroy(): Promise<void> {
		return this.driver.destroyAll(this.id, this.extra, this.network);
	}
}
