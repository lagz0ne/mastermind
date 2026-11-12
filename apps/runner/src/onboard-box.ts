/**
 * `onboard`, box part (mm-210.67): find the box engine by itself, and when
 * there is none, say exactly what to install or start on THIS machine.
 *
 * Order (the same sockets the Docker CLI, Podman and Docker Desktop use):
 *   1. DOCKER_HOST, when set
 *   2. /var/run/docker.sock
 *   3. rootless Podman: $XDG_RUNTIME_DIR/podman/podman.sock, /run/user/<uid>/podman/podman.sock
 *   4. rootful Podman /run/podman/podman.sock, Docker Desktop ~/.docker/run/docker.sock,
 *      Colima ~/.colima/default/docker.sock, rootless Docker $XDG_RUNTIME_DIR/docker.sock
 * A socket that answers but is not where `start` looks by default: onboard
 * uses it and prints the `export DOCKER_HOST=...` line for `start`.
 *
 * gVisor (optional): the engine lists `runsc` in GET /info Runtimes. Podman
 * lists runtimes from containers.conf even when the binary is missing, so on a
 * local socket only runtimes whose binary exists count.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type DockerEndpoint, dockerEndpoint } from "./box/docker.ts";

export const GVISOR_RUNTIME = "runsc";
export const GVISOR_INSTALL = "https://gvisor.dev/docs/user_guide/install/";
export const PODMAN_INSTALL = "https://podman.io/docs/installation";
export const DOCKER_POSTINSTALL =
	"https://docs.docker.com/engine/install/linux-postinstall/";

export type EngineDeps = {
	env: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	uid?: number;
	exists?: (path: string) => boolean;
	which?: (cmd: string) => string | null;
	/** /etc/os-release text (Linux distro for the install link). */
	osRelease?: () => string;
	/** GET <path> on the engine: status and JSON body. Throws when it cannot connect. */
	get?: (
		ep: DockerEndpoint,
		path: string,
	) => Promise<{ status: number; body: unknown }>;
};

export type EngineFound = {
	ok: true;
	endpoint: DockerEndpoint;
	/** Env for the driver and the devcontainer CLI (DOCKER_HOST set when found elsewhere). */
	env: Record<string, string | undefined>;
	/** `export DOCKER_HOST=...` for `start`, when the socket is not a default one. */
	exportLine?: string;
	podman: boolean;
	version: string;
	runtimes: string[];
};
export type EngineMissing = { ok: false; problem: string; fix: string };

const defaultGet: NonNullable<EngineDeps["get"]> = async (ep, path) => {
	const res = await fetch(`${ep.base}${path}`, {
		signal: AbortSignal.timeout(10_000),
		...(ep.unix ? { unix: ep.unix } : {}),
	} as RequestInit);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: res.status, body };
};

/** The install page for this OS (Docker Engine per distro; Docker Desktop on macOS). */
export function installLink(
	platform: NodeJS.Platform,
	osRelease = "",
): { docker: string; podman: string } {
	if (platform === "darwin")
		return {
			docker: "https://docs.docker.com/desktop/setup/install/mac-install/",
			podman: PODMAN_INSTALL,
		};
	if (platform === "win32")
		return {
			docker: "https://docs.docker.com/desktop/setup/install/windows-install/",
			podman: PODMAN_INSTALL,
		};
	const field = (k: string) =>
		osRelease
			.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]
			?.replace(/^"|"$/g, "")
			.toLowerCase() ?? "";
	const ids = [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);
	// Docker's own pages; RHEL-like distros use the RHEL page, Fedora its own.
	const pages: Record<string, string> = {
		ubuntu: "ubuntu",
		debian: "debian",
		raspbian: "raspberry-pi-os",
		fedora: "fedora",
		rhel: "rhel",
		centos: "centos",
		rocky: "rhel",
		almalinux: "rhel",
		sles: "sles",
	};
	const page = ids.map((i) => pages[i]).find(Boolean);
	return {
		docker: `https://docs.docker.com/engine/install/${page ? `${page}/` : ""}`,
		podman: PODMAN_INSTALL,
	};
}

/** Sockets to try, in order, with the DOCKER_HOST value that names each. */
export function candidateSockets(d: EngineDeps): string[] {
	const env = d.env;
	const uid = d.uid ?? process.getuid?.() ?? 0;
	const home = env.HOME ?? "";
	const xdg = env.XDG_RUNTIME_DIR;
	return [
		...new Set(
			[
				"/var/run/docker.sock",
				xdg ? `${xdg}/podman/podman.sock` : "",
				`/run/user/${uid}/podman/podman.sock`,
				"/run/podman/podman.sock",
				home ? `${home}/.docker/run/docker.sock` : "",
				home ? `${home}/.colima/default/docker.sock` : "",
				xdg ? `${xdg}/docker.sock` : "",
			].filter(Boolean),
		),
	];
}

/** Runtimes the engine can really use (Podman: binary present; remote engine: as listed). */
export function usableRuntimes(
	info: unknown,
	local: boolean,
	exists: (p: string) => boolean,
	which: (c: string) => string | null,
): string[] {
	const r = (info as { Runtimes?: Record<string, { path?: string }> })
		?.Runtimes;
	if (!r || typeof r !== "object") return [];
	return Object.entries(r)
		.filter(([name, v]) => {
			if (!local) return true;
			const p = v?.path || name;
			return isAbsolute(p) ? exists(p) : which(p) !== null;
		})
		.map(([name]) => name)
		.sort();
}

async function probe(
	ep: DockerEndpoint,
	d: EngineDeps,
): Promise<
	| { ok: true; podman: boolean; version: string; runtimes: string[] }
	| { ok: false; why: string }
> {
	const get = d.get ?? defaultGet;
	let v: { status: number; body: unknown };
	try {
		v = await get(ep, "/version");
	} catch (error) {
		const m = error instanceof Error ? error.message : String(error);
		return { ok: false, why: m };
	}
	if (v.status !== 200) return { ok: false, why: `answered ${v.status}` };
	const body = v.body as {
		Version?: string;
		Components?: { Name?: string }[];
	};
	const podman = (body.Components ?? []).some((c) =>
		/podman/i.test(c.Name ?? ""),
	);
	let runtimes: string[] = [];
	try {
		const info = await get(ep, "/info");
		if (info.status === 200)
			runtimes = usableRuntimes(
				info.body,
				!!ep.unix,
				d.exists ?? existsSync,
				d.which ?? Bun.which,
			);
	} catch {}
	return {
		ok: true,
		podman,
		version: `${podman ? "Podman" : "Docker"} ${body.Version ?? "?"}`,
		runtimes,
	};
}

const unixEp = (path: string): DockerEndpoint => ({
	base: "http://docker",
	unix: path,
	label: `unix://${path}`,
});

/**
 * Find a box engine that answers. Not found: the problem and the one fix for
 * this machine (install link, start the daemon, socket permission).
 */
export async function findEngine(
	d: EngineDeps,
): Promise<EngineFound | EngineMissing> {
	const exists = d.exists ?? existsSync;
	const which = d.which ?? Bun.which;
	const platform = d.platform ?? process.platform;
	const found = (
		ep: DockerEndpoint,
		p: { podman: boolean; version: string; runtimes: string[] },
		exportLine?: string,
	): EngineFound => ({
		ok: true,
		endpoint: ep,
		env: exportLine ? { ...d.env, DOCKER_HOST: ep.label } : d.env,
		...(exportLine ? { exportLine } : {}),
		...p,
	});

	// DOCKER_HOST set: that one only (the user chose it).
	if (d.env.DOCKER_HOST?.trim()) {
		let ep: DockerEndpoint;
		try {
			ep = dockerEndpoint(d.env, exists);
		} catch (error) {
			return {
				ok: false,
				problem: error instanceof Error ? error.message : String(error),
				fix: "set DOCKER_HOST=unix:///path/to/docker.sock (or tcp://host:port), or unset it",
			};
		}
		const p = await probe(ep, d);
		if (p.ok) return found(ep, p);
		return {
			ok: false,
			problem: `DOCKER_HOST=${d.env.DOCKER_HOST} does not answer (${p.why})`,
			fix: "start the engine behind DOCKER_HOST, or unset DOCKER_HOST to let onboard look for one",
		};
	}

	// The default endpoint first (what `start` uses without DOCKER_HOST).
	const def = dockerEndpoint(d.env, exists);
	const seen: { path: string; why: string }[] = [];
	if (def.unix && exists(def.unix)) {
		const p = await probe(def, d);
		if (p.ok) return found(def, p);
		seen.push({ path: def.unix, why: p.why });
	}
	for (const path of candidateSockets(d)) {
		if (path === def.unix || !exists(path)) continue;
		const ep = unixEp(path);
		const p = await probe(ep, d);
		if (p.ok) return found(ep, p, `export DOCKER_HOST=${ep.label}`);
		seen.push({ path, why: p.why });
	}

	// Nothing answers: say why, for this machine.
	const denied = seen.find((s) => /permission|EACCES/i.test(s.why));
	if (denied)
		return {
			ok: false,
			problem: `${denied.path} exists but this user may not use it (${denied.why})`,
			fix:
				platform === "linux"
					? `add this user to the docker group: sudo usermod -aG docker $USER, then log in again (${DOCKER_POSTINSTALL}); or use rootless Podman: systemctl --user enable --now podman.socket`
					: "give this user access to the engine socket",
		};
	if (seen.length)
		return {
			ok: false,
			problem: `the box engine socket ${seen[0]?.path} does not answer (${seen[0]?.why})`,
			fix:
				platform === "darwin"
					? "start Docker Desktop (or: colima start / podman machine start)"
					: "start the engine: sudo systemctl start docker (Docker) or systemctl --user start podman.socket (Podman)",
		};
	const links = installLink(
		platform,
		d.osRelease?.() ?? readOsRelease(platform),
	);
	if (which("podman"))
		return {
			ok: false,
			problem: "Podman is installed but its API socket is off",
			fix:
				platform === "linux"
					? "systemctl --user enable --now podman.socket (then run onboard again)"
					: "podman machine init && podman machine start",
		};
	if (which("docker") || which("dockerd"))
		return {
			ok: false,
			problem: "Docker is installed but the daemon does not run",
			fix:
				platform === "darwin"
					? "start Docker Desktop"
					: "sudo systemctl enable --now docker",
		};
	return {
		ok: false,
		problem: "no box engine on this machine (no Docker, no Podman)",
		fix: `install Docker: ${links.docker} (or Podman: ${links.podman}), then run onboard again; or onboard with --no-box at your own risk`,
	};
}

function readOsRelease(platform: NodeJS.Platform): string {
	if (platform !== "linux") return "";
	try {
		return readFileSync("/etc/os-release", "utf8");
	} catch {
		return "";
	}
}

/** The gVisor line of the engine step (optional). */
export function gvisorLine(runtimes: string[]): string {
	return runtimes.includes(GVISOR_RUNTIME)
		? "gVisor (runsc) available"
		: `gVisor not installed (optional, stronger isolation: ${GVISOR_INSTALL})`;
}
