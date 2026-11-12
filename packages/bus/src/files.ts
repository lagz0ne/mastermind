import { type JetStreamManager, jetstream } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { type ObjectInfo, type ObjectStore, Objm } from "@nats-io/obj";
import { BusError } from "./codec.ts";

/**
 * Files on a JetStream object store bucket (mm-210.60): task inputs and
 * outputs. Every transfer streams in chunks (128 KiB); no call holds a whole
 * file in memory.
 *
 *   mm_files              inputs uploaded by humans; only the api reads it
 *   mm_files_<account>    one per runner account: the inputs of the items it
 *                         runs (copied by the api) and the outputs it makes;
 *                         the auth callout gives a service account this
 *                         bucket and no other (filesPermissions)
 *
 * Object names: `<item>/in/<name>` and `<item>/out/<name>`.
 *
 * `get` reads one chunk per request (STREAM.MSG.GET), only as fast as the
 * reader pulls, so a slow download does not fill memory; `list` reads the
 * meta subjects with STREAM.INFO. Neither creates a consumer, so a service
 * account needs only the subjects in `filesPermissions`.
 */

/** The inputs bucket (api only). */
export const INPUTS_BUCKET = "mm_files";

/** The bucket of a runner account. */
export const accountFilesBucket = (account: string) => `mm_files_${account}`;

/** The JetStream stream behind an object store bucket. */
export const objectStream = (bucket: string) => `OBJ_${bucket}`;

/**
 * Subjects a service account needs to read and write its own bucket, and
 * nothing of any other bucket: publish chunks and meta, stream info (open,
 * list), message get (read), purge (delete, clean up a failed put).
 */
export function filesPermissions(bucket: string): string[] {
	const stream = objectStream(bucket);
	return [
		`$O.${bucket}.>`,
		`$JS.API.STREAM.INFO.${stream}`,
		`$JS.API.STREAM.MSG.GET.${stream}`,
		`$JS.API.STREAM.PURGE.${stream}`,
	];
}

export type FileInfo = {
	name: string;
	size: number;
	/** Lower-case hex. */
	sha256: string;
	/** ISO 8601. */
	mtime: string;
	contentType?: string;
};

export type FilesOptions = {
	/** Create the bucket when it does not exist (the api). False: bind only (runners). */
	create?: boolean;
	/** Objects expire this many ms after they were written. 0 or absent: never. */
	ttlMs?: number;
	/** Bucket size limit, bytes. JetStream reserves it against the account's max_file. */
	maxBytes?: number;
	/** Largest object, bytes; a bigger put fails and leaves nothing. */
	maxObjectBytes?: number;
};

export type PutMeta = {
	contentType?: string;
	/** Expected size; a different size fails the put and leaves nothing. */
	size?: number;
	/** Expected sha256 (hex); a different digest fails the put and leaves nothing. */
	sha256?: string;
};

/** Default largest object: 512 MiB. */
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const CHUNK = 128 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const hex = (b: Uint8Array) =>
	Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** "SHA-256=<base64url>" (object store digest) to hex. */
function digestHex(digest: string): string {
	const b64 = digest.replace(/^SHA-256=/, "");
	const std = b64.replace(/-/g, "+").replace(/_/g, "/");
	return hex(Uint8Array.from(atob(std), (c) => c.charCodeAt(0)));
}

function toFileInfo(o: ObjectInfo): FileInfo {
	const contentType = o.metadata?.["content-type"];
	return {
		name: o.name,
		size: o.size,
		sha256: digestHex(o.digest),
		mtime: o.mtime,
		...(contentType ? { contentType } : {}),
	};
}

type StreamInfoReply = {
	error?: { code: number; err_code?: number; description: string };
	total?: number;
	state?: { subjects?: Record<string, number> };
};

export class Files {
	private constructor(
		readonly bucket: string,
		private readonly os: ObjectStore,
		private readonly jsm: JetStreamManager,
		private readonly nc: NatsConnection,
		private readonly maxObjectBytes: number,
	) {}

	static async open(
		nc: NatsConnection,
		bucket: string,
		opts: FilesOptions = {},
	): Promise<Files> {
		// checkAPI false: no $JS.API.INFO request (a service account may not send it).
		const js = jetstream(nc, { checkAPI: false, timeout: REQUEST_TIMEOUT_MS });
		const objm = new Objm(js);
		let os: ObjectStore;
		try {
			os = opts.create
				? await objm.create(bucket, {
						...(opts.ttlMs ? { ttl: opts.ttlMs * 1_000_000 } : {}),
						...(opts.maxBytes ? { max_bytes: opts.maxBytes } : {}),
					})
				: await objm.open(bucket);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/not found/i.test(msg))
				throw new BusError(
					"not_found",
					`files bucket ${bucket} does not exist`,
					{
						cause: err,
					},
				);
			throw new Error(`files bucket ${bucket}: open: ${msg}`, { cause: err });
		}
		return new Files(
			bucket,
			os,
			await js.jetstreamManager(false),
			nc,
			opts.maxObjectBytes ?? MAX_OBJECT_BYTES,
		);
	}

	/**
	 * Store `data` as `name`, replacing an earlier object of that name. Fails with BusError("bad_request") when
	 * the data is bigger than the object limit or does not match `meta.size`
	 * or `meta.sha256`; then nothing of the new object stays.
	 */
	async put(
		name: string,
		data: ReadableStream<Uint8Array>,
		meta: PutMeta = {},
	): Promise<FileInfo> {
		const limit = this.maxObjectBytes;
		let seen = 0;
		const counted = data.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, ctl) {
					seen += chunk.byteLength;
					if (seen > limit)
						ctl.error(
							new BusError(
								"bad_request",
								`${name}: larger than the limit of ${limit} bytes`,
							),
						);
					else ctl.enqueue(chunk);
				},
			}),
		);
		const metadata: Record<string, string> = {};
		if (meta.contentType) metadata["content-type"] = meta.contentType;
		let info: FileInfo;
		try {
			info = toFileInfo(
				await this.os.put(
					{
						name,
						options: { max_chunk_size: CHUNK },
						...(meta.contentType ? { metadata } : {}),
					},
					counted,
				),
			);
		} catch (err) {
			if (err instanceof BusError) throw err;
			if (seen > limit)
				throw new BusError(
					"bad_request",
					`${name}: larger than the limit of ${limit} bytes`,
					{ cause: err },
				);
			throw err;
		}
		const wrong =
			meta.size !== undefined && meta.size !== info.size
				? `size ${info.size}, expected ${meta.size}`
				: meta.sha256 !== undefined && meta.sha256.toLowerCase() !== info.sha256
					? `sha256 ${info.sha256}, expected ${meta.sha256.toLowerCase()}`
					: null;
		if (wrong) {
			await this.os.delete(name).catch(() => {});
			throw new BusError("bad_request", `${name}: ${wrong}`);
		}
		return info;
	}

	async info(name: string): Promise<FileInfo | null> {
		const o = await this.os.info(name);
		return o && !o.deleted ? toFileInfo(o) : null;
	}

	/**
	 * The object as a stream, or null when it does not exist. The stream
	 * errors when a chunk is missing or the sha256 does not match.
	 */
	async get(
		name: string,
	): Promise<{ info: FileInfo; data: ReadableStream<Uint8Array> } | null> {
		const o = await this.os.info(name);
		if (!o || o.deleted) return null;
		if (o.options?.link) throw new BusError("bad_request", `${name} is a link`);
		const info = toFileInfo(o);
		const stream = objectStream(this.bucket);
		const subj = `$O.${this.bucket}.C.${o.nuid}`;
		const jsm = this.jsm;
		const hasher = new Bun.CryptoHasher("sha256");
		let seq = 0;
		let read = 0;
		let chunks = 0;
		const data = new ReadableStream<Uint8Array>(
			{
				async pull(ctl) {
					if (chunks >= o.chunks) {
						const got = hasher.digest("hex");
						if (read !== o.size || got !== info.sha256)
							ctl.error(
								new Error(
									`${name}: corrupt (size ${read}/${o.size}, sha256 ${got})`,
								),
							);
						else ctl.close();
						return;
					}
					// The first chunk at or after seq + 1 (the server takes
					// next_by_subj on MSG.GET; the client type does not list it).
					const next = { seq: seq + 1, next_by_subj: subj };
					const m = await jsm.streams.getMessage(stream, next);
					if (!m) {
						ctl.error(new Error(`${name}: chunk ${chunks + 1} is missing`));
						return;
					}
					seq = m.seq;
					chunks++;
					read += m.data.byteLength;
					hasher.update(m.data);
					ctl.enqueue(m.data);
				},
			},
			{ highWaterMark: 1 },
		);
		return { info, data };
	}

	/**
	 * Live objects whose name starts with `prefix`, sorted by name. Reads every
	 * meta entry of the bucket (one STREAM.INFO, one get per object).
	 */
	async list(prefix = ""): Promise<FileInfo[]> {
		const stream = objectStream(this.bucket);
		const metaPrefix = `$O.${this.bucket}.M.`;
		const subjects: string[] = [];
		for (let offset = 0; ; ) {
			const msg = await this.nc.request(
				`$JS.API.STREAM.INFO.${stream}`,
				JSON.stringify({ subjects_filter: `${metaPrefix}>`, offset }),
				{ timeout: REQUEST_TIMEOUT_MS },
			);
			const r = msg.json<StreamInfoReply>();
			if (r.error)
				throw new Error(
					`${this.bucket}: list: ${r.error.description} (${r.error.err_code ?? r.error.code})`,
				);
			const page = Object.keys(r.state?.subjects ?? {});
			subjects.push(...page);
			offset += page.length;
			if (page.length === 0 || offset >= (r.total ?? 0)) break;
		}
		const found = await Promise.all(
			subjects.map(async (s) => {
				const m = await this.jsm.streams.getMessage(stream, {
					last_by_subj: s,
				});
				if (!m) return null;
				const o = m.json<ObjectInfo>();
				return o.deleted || !o.name.startsWith(prefix) ? null : toFileInfo(o);
			}),
		);
		return found
			.filter((f): f is FileInfo => f !== null)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/** Delete; false when it did not exist. */
	async delete(name: string): Promise<boolean> {
		const o = await this.os.info(name);
		if (!o || o.deleted) return false;
		await this.os.delete(name);
		return true;
	}

	/** Copy `name` into `to` (as `toName`), streaming; null when it does not exist. */
	async copyTo(
		name: string,
		to: Files,
		toName = name,
	): Promise<FileInfo | null> {
		const src = await this.get(name);
		if (!src) return null;
		return to.put(toName, src.data, {
			size: src.info.size,
			sha256: src.info.sha256,
			...(src.info.contentType ? { contentType: src.info.contentType } : {}),
		});
	}

	/** Object count and bytes of live objects. */
	async usage(): Promise<{ files: number; bytes: number }> {
		const all = await this.list();
		return {
			files: all.length,
			bytes: all.reduce((n, f) => n + f.size, 0),
		};
	}
}
