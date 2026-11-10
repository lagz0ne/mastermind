// Where backups go: BACKUP_URL. Two kinds, both configuration only:
//   file:///backups/nats       a directory (a volume of the app container)
//   s3://bucket/some/prefix    an S3-compatible bucket. Credentials and endpoint come from the
//                              standard env that Bun's S3 client reads: S3_ACCESS_KEY_ID,
//                              S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION (or the AWS_* names).
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A sink that takes chunks in order. */
export type Sink = {
	write(chunk: Uint8Array): unknown;
	end(): unknown;
};

/** Paths are relative to the target root and use `/`. */
export type Target = {
	readonly url: string;
	writer(path: string): Promise<Sink>;
	write(path: string, data: string): Promise<void>;
	read(path: string): Promise<ReadableStream<Uint8Array>>;
	text(path: string): Promise<string | null>;
	/** Names of the direct children of `dir` (files and dirs), sorted. */
	list(dir: string): Promise<string[]>;
	/** Remove `dir` and everything under it. */
	remove(dir: string): Promise<void>;
};

export function openTarget(url: string): Target {
	const parsed = new URL(url);
	if (parsed.protocol === "file:") return fileTarget(url);
	if (parsed.protocol === "s3:") return s3Target(url);
	throw new Error(
		`BACKUP_URL must be file:///<dir> or s3://<bucket>/<prefix>, not ${parsed.protocol}`,
	);
}

function fileTarget(url: string): Target {
	const root = fileURLToPath(url);
	const at = (path: string) => join(root, path);
	return {
		url,
		async writer(path) {
			await mkdir(dirname(at(path)), { recursive: true });
			return Bun.file(at(path)).writer();
		},
		async write(path, data) {
			await mkdir(dirname(at(path)), { recursive: true });
			await Bun.write(at(path), data);
		},
		async read(path) {
			return Bun.file(at(path)).stream();
		},
		async text(path) {
			const f = Bun.file(at(path));
			return (await f.exists()) ? f.text() : null;
		},
		async list(dir) {
			const names = await readdir(at(dir)).catch((error) => {
				if ((error as { code?: string }).code === "ENOENT") return [];
				throw error;
			});
			return names.sort();
		},
		async remove(dir) {
			await rm(at(dir), { recursive: true, force: true });
		},
	};
}

function s3Target(url: string): Target {
	const parsed = new URL(url);
	const client = new Bun.S3Client({ bucket: parsed.hostname });
	const base = parsed.pathname.replace(/^\/+|\/+$/g, "");
	const key = (path: string) => (base ? `${base}/${path}` : path);
	async function keys(prefix: string): Promise<string[]> {
		const out: string[] = [];
		let startAfter: string | undefined;
		for (;;) {
			const page = await client.list({ prefix, startAfter });
			for (const c of page.contents ?? []) out.push(c.key);
			if (!page.isTruncated || !page.contents?.length) return out;
			startAfter = page.contents.at(-1)?.key;
		}
	}
	return {
		url,
		async writer(path) {
			return client.file(key(path)).writer();
		},
		async write(path, data) {
			await client.write(key(path), data);
		},
		async read(path) {
			return client.file(key(path)).stream();
		},
		async text(path) {
			const f = client.file(key(path));
			return (await f.exists()) ? f.text() : null;
		},
		async list(dir) {
			const prefix = `${key(dir)}/`.replace(/^\/+/, "");
			const names = new Set<string>();
			for (const k of await keys(prefix)) {
				const name = k.slice(prefix.length).split("/")[0];
				if (name) names.add(name);
			}
			return [...names].sort();
		},
		async remove(dir) {
			const prefix = `${key(dir)}/`;
			for (const k of await keys(prefix)) await client.delete(k);
		},
	};
}
