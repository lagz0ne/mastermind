/**
 * The runner (apps/runner) as one compiled executable per platform. The api
 * build (apps/api/build.ts) writes them next to index.js, gzipped, with a
 * manifest; the server serves them at /download/mastermind-runner. So a runner
 * always comes from the same commit as the server it talks to.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const TARGETS = [
	"linux-x64",
	"linux-arm64",
	"darwin-arm64",
	"darwin-x64",
] as const;
export type Target = (typeof TARGETS)[number];

export const isTarget = (t: string): t is Target =>
	(TARGETS as readonly string[]).includes(t);

/** Directory of the binaries, relative to the built index.js. */
export const RUNNER_DIR = "runner";
export const MANIFEST = "manifest.json";

export type ManifestEntry = {
	/** File name in the runner directory. */
	file: string;
	/** The file is gzip; the sha256 and size are of the executable inside. */
	gzip: boolean;
	sha256: string;
	size: number;
};

export type Manifest = {
	/** The commit the binaries were built from (the runner's VERSION). */
	version: string;
	targets: Partial<Record<Target, ManifestEntry>>;
};

/** `linux-x64,darwin-arm64` → targets; `all` → every target. */
export function parseTargets(list: string): Target[] {
	if (list.trim() === "all") return [...TARGETS];
	const out: Target[] = [];
	for (const raw of list.split(",")) {
		const t = raw.trim();
		if (!t) continue;
		if (!isTarget(t))
			throw new Error(
				`unknown runner target ${t} (one of ${TARGETS.join(", ")})`,
			);
		if (!out.includes(t)) out.push(t);
	}
	return out;
}

export const sha256 = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Compile the runner CLI for one target to `outfile`; returns the executable. */
export async function compileRunner(opts: {
	source: string;
	target: Target;
	outfile: string;
	version: string;
}): Promise<Uint8Array<ArrayBuffer>> {
	const out = await Bun.build({
		entrypoints: [opts.source],
		compile: { target: `bun-${opts.target}`, outfile: opts.outfile },
		minify: true,
		define: {
			"process.env.MASTERMIND_RUNNER_VERSION": JSON.stringify(opts.version),
		},
	});
	if (!out.success)
		throw new Error(
			`runner ${opts.target}: compile failed: ${out.logs.join("\n")}`,
		);
	return Bun.file(opts.outfile).bytes();
}

/**
 * Compile every target into `dir` as `mastermind-runner-<target>.gz` and write
 * the manifest. Returns the manifest.
 */
export async function buildRunners(opts: {
	source: string;
	dir: string;
	targets: Target[];
	version: string;
	log?: (line: string) => void;
}): Promise<Manifest> {
	await mkdir(opts.dir, { recursive: true });
	const manifest: Manifest = { version: opts.version, targets: {} };
	for (const target of opts.targets) {
		const raw = join(opts.dir, `mastermind-runner-${target}`);
		const exe = await compileRunner({
			source: opts.source,
			target,
			outfile: raw,
			version: opts.version,
		});
		const file = `mastermind-runner-${target}.gz`;
		const gz = Bun.gzipSync(exe, { level: 9 });
		await Bun.write(join(opts.dir, file), gz);
		await Bun.file(raw).delete();
		manifest.targets[target] = {
			file,
			gzip: true,
			sha256: sha256(exe),
			size: exe.length,
		};
		opts.log?.(
			`${file}  ${(exe.length / 2 ** 20).toFixed(1)} MiB, gzip ${(gz.length / 2 ** 20).toFixed(1)} MiB`,
		);
	}
	await Bun.write(
		join(opts.dir, MANIFEST),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return manifest;
}
