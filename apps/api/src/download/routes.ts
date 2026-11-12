/**
 * Public downloads for a runner machine (no session: the enrol token is the secret).
 *
 *   GET /install.sh                                          the installer, for `curl … | sh`
 *   GET /download/mastermind-runner?os=<os>&arch=<arch>      the executable
 *   GET /download/mastermind-runner.sha256?os=<os>&arch=<arch>   `<sha256>  mastermind-runner`
 *   GET /download/runner-setup                               the guide "Set up a worker" (apps/runner/SETUP.md)
 *
 * os: linux | darwin; arch: x64 | arm64. The binaries come from the image build
 * (runner/manifest.json next to index.js), so they match this server's commit.
 * Without a manifest and with the runner source at hand (dev), a target is
 * compiled on its first request.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
// The guide is bundled into the server, so every install serves its own copy.
import setupGuide from "../../../runner/SETUP.md" with { type: "text" };
import { installScript, SAFE_ORIGIN } from "./install-script.ts";
import {
	compileRunner,
	isTarget,
	MANIFEST,
	type Manifest,
	type ManifestEntry,
	RUNNER_DIR,
	sha256,
	type Target,
} from "./runner-build.ts";

export type DownloadOptions = {
	/** Directory with manifest.json and the binaries. Default: runner/ next to this module. */
	dir?: string;
	/** Runner source for the dev fallback; null turns the fallback off. */
	source?: string | null;
	/** Version the dev fallback stamps into the binaries. */
	version?: string;
	onError?: (error: unknown) => void;
};

/** A servable binary: where it is and what the client must get. */
type Binary = ManifestEntry & { path: string };

const SOURCE = join(import.meta.dir, "../../../runner/src/cli.ts");

const fail = (status: number, error: string) =>
	Response.json({ error }, { status });

/** The origin the client used: forwarded proto/host first (TLS ends at the proxy). */
export function requestOrigin(req: Request): string {
	const url = new URL(req.url);
	const first = (h: string) => req.headers.get(h)?.split(",")[0]?.trim();
	const proto = first("x-forwarded-proto") || url.protocol.slice(0, -1);
	const host = first("x-forwarded-host") || req.headers.get("host") || url.host;
	const origin = `${proto}://${host}`;
	return SAFE_ORIGIN.test(origin) ? origin : url.origin;
}

/** `?os=&arch=` → target, or an error message. */
export function targetOf(url: URL): Target | string {
	const os = url.searchParams.get("os");
	const arch = url.searchParams.get("arch");
	if (!os || !arch) return "pass os (linux, darwin) and arch (x64, arm64)";
	const t = `${os}-${arch}`;
	return isTarget(t) ? t : `no runner build for ${t}`;
}

export function downloadRoutes(opts: DownloadOptions = {}) {
	const dir = opts.dir ?? join(import.meta.dir, RUNNER_DIR);
	const source = opts.source === undefined ? SOURCE : opts.source;
	let manifest: Promise<Manifest | null> | null = null;
	const compiled = new Map<Target, Promise<Binary>>();

	const loadManifest = async (): Promise<Manifest | null> => {
		const file = Bun.file(join(dir, MANIFEST));
		return (await file.exists()) ? ((await file.json()) as Manifest) : null;
	};

	/** Dev: compile the target once into a temp dir. */
	const compile = (target: Target, src: string): Promise<Binary> => {
		let p = compiled.get(target);
		if (!p) {
			const outfile = join(
				tmpdir(),
				`mastermind-runner-dev-${process.pid}-${target}`,
			);
			p = compileRunner({
				source: src,
				target,
				outfile,
				version: opts.version ?? "dev",
			}).then((exe) => ({
				file: outfile,
				path: outfile,
				gzip: false,
				sha256: sha256(exe),
				size: exe.length,
			}));
			p.catch(() => compiled.delete(target));
			compiled.set(target, p);
		}
		return p;
	};

	async function binary(target: Target): Promise<Binary | null> {
		manifest ??= loadManifest().catch((error) => {
			manifest = null;
			throw error;
		});
		const m = await manifest;
		if (m) {
			const e = m.targets[target];
			return e ? { ...e, path: join(dir, e.file) } : null;
		}
		if (source && (await Bun.file(source).exists()))
			return compile(target, source);
		return null;
	}

	/** Resolve the target of a request, then answer with `fn`. */
	const withBinary =
		(fn: (req: Request, b: Binary) => Response) =>
		async (req: Request): Promise<Response> => {
			const target = targetOf(new URL(req.url));
			if (!isTarget(target)) return fail(400, target);
			try {
				const b = await binary(target);
				if (!b)
					return fail(404, `no runner build for ${target} on this server`);
				return fn(req, b);
			} catch (error) {
				opts.onError?.(error);
				return fail(500, "runner build failed");
			}
		};

	return {
		"/install.sh": {
			GET: (req: Request): Response =>
				new Response(installScript(requestOrigin(req)), {
					headers: {
						"content-type": "text/x-shellscript; charset=utf-8",
						"cache-control": "no-cache",
					},
				}),
		},
		"/download/runner-setup": {
			GET: (): Response =>
				new Response(setupGuide, {
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "no-cache",
					},
				}),
		},
		"/download/mastermind-runner.sha256": {
			GET: withBinary(
				(_req, b) =>
					new Response(`${b.sha256}  mastermind-runner\n`, {
						headers: {
							"content-type": "text/plain; charset=utf-8",
							"cache-control": "no-cache",
						},
					}),
			),
		},
		"/download/mastermind-runner": {
			GET: withBinary((req, b) => {
				const headers: Record<string, string> = {
					"content-type": "application/octet-stream",
					"content-disposition": 'attachment; filename="mastermind-runner"',
					"cache-control": "no-cache",
					"x-content-sha256": b.sha256,
				};
				const file = Bun.file(b.path);
				if (!b.gzip) return new Response(file, { headers });
				// Stored gzipped: send it as is to a client that takes gzip (curl --compressed).
				if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? ""))
					return new Response(file, {
						headers: {
							...headers,
							"content-encoding": "gzip",
							vary: "accept-encoding",
						},
					});
				return new Response(
					file.stream().pipeThrough(new DecompressionStream("gzip")),
					{ headers: { ...headers, vary: "accept-encoding" } },
				);
			}),
		},
	};
}
