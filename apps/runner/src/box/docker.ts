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
import { tar } from "./tar.ts";

const API = "/v1.41";
/** Most output kept per exec stream. */
const MAX_OUTPUT = 4 * 1024 * 1024;

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
};

export class DockerDriver implements BoxDriver {
	readonly #ep: DockerEndpoint;
	readonly #repo: string;
	readonly #log: (line: string) => void;
	readonly #callMs: number;
	readonly #imageMs: number;
	/** One build per image at a time. */
	readonly #building = new Map<string, Promise<string>>();

	constructor(opts: DockerDriverOptions = {}) {
		this.#ep = opts.endpoint ?? dockerEndpoint(opts.env);
		this.#repo = opts.repository ?? "mastermind-box";
		this.#log = opts.log ?? (() => {});
		this.#callMs = opts.callTimeoutMs ?? 60_000;
		this.#imageMs = opts.imageTimeoutMs ?? 30 * 60_000;
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
			signal?: AbortSignal;
			ok404?: boolean;
			/** Default: the call timeout. null: none (exec output, bounded by the box). */
			timeoutMs?: number | null;
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
		let body: Uint8Array | string | undefined;
		if (init.raw) {
			headers["content-type"] = "application/x-tar";
			body = init.raw;
		} else if (init.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.body);
		}
		let res: Response;
		try {
			res = await fetch(`${this.#ep.base}${API}${path}`, {
				method,
				headers,
				body,
				signal,
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
		if (typeof net === "object")
			throw new BoxError(
				"network allow lists are not supported by the docker driver yet; use open or none",
			);
		const host: Record<string, unknown> = {
			Init: true,
			SecurityOpt: ["no-new-privileges"],
		};
		if (spec.limits?.cpu) host.NanoCpus = Math.round(spec.limits.cpu * 1e9);
		if (spec.limits?.memoryMb) host.Memory = spec.limits.memoryMb * 1024 * 1024;
		if (net === "none") host.NetworkMode = "none";
		const res = await this.#fetch(
			"POST",
			`/containers/create?name=${encodeURIComponent(spec.name)}`,
			{
				body: {
					Image: spec.image,
					...(spec.cmd ? { Cmd: spec.cmd } : {}),
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
			await this.remove(Id).catch(() => {});
			throw error;
		}
		return new DockerBox(this, Id, spec.name);
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
		await this.#fetch("DELETE", `/containers/${id}?force=1&v=1`, {
			ok404: true,
		});
	}

	/** @internal for DockerBox */
	request(
		method: string,
		path: string,
		init?: {
			body?: unknown;
			raw?: Uint8Array;
			signal?: AbortSignal;
			timeoutMs?: number | null;
		},
	): Promise<Response> {
		return this.#fetch(method, path, init);
	}
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

	async copyOut(path: string): Promise<Uint8Array> {
		const res = await this.driver.request(
			"GET",
			`/containers/${this.id}/archive?path=${encodeURIComponent(path)}`,
		);
		return new Uint8Array(await res.arrayBuffer());
	}

	async logs(tail = 100): Promise<string> {
		const res = await this.driver.request(
			"GET",
			`/containers/${this.id}/logs?stdout=1&stderr=1&tail=${tail}`,
		);
		const d = await demux(res);
		return `${d.stdout}${d.stderr}`;
	}

	destroy(): Promise<void> {
		return this.driver.remove(this.id);
	}
}
