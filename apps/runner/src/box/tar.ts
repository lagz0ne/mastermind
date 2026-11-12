/**
 * The smallest ustar writer and reader the box needs: the Docker Engine API
 * takes files in (`PUT /containers/{id}/archive`, `POST /build`) and gives
 * files out (`GET /containers/{id}/archive`) as tar.
 */

export type TarEntry = {
	/** Path inside the archive, no leading slash. At most 100 bytes. */
	name: string;
	data: string | Uint8Array;
	/** File mode; default 0o644. */
	mode?: number;
};

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function octal(n: number, width: number): string {
	return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number): Uint8Array {
	const nameBytes = enc.encode(name);
	if (nameBytes.length > 100) throw new Error(`tar: name too long: ${name}`);
	const h = new Uint8Array(BLOCK);
	h.set(nameBytes, 0);
	h.set(enc.encode(octal(mode, 8)), 100);
	h.set(enc.encode(octal(0, 8)), 108); // uid
	h.set(enc.encode(octal(0, 8)), 116); // gid
	h.set(enc.encode(octal(size, 12)), 124);
	h.set(enc.encode(octal(Math.floor(Date.now() / 1000), 12)), 136);
	h.set(enc.encode("        "), 148); // checksum placeholder
	h[156] = "0".charCodeAt(0); // regular file
	h.set(enc.encode("ustar\0"), 257);
	h.set(enc.encode("00"), 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return h;
}

/** A tar archive of regular files. */
export function tar(entries: TarEntry[]): Uint8Array {
	const parts: Uint8Array[] = [];
	let total = 0;
	for (const e of entries) {
		const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
		const h = header(e.name, data.length, e.mode ?? 0o644);
		const padded = Math.ceil(data.length / BLOCK) * BLOCK;
		const body = new Uint8Array(padded);
		body.set(data);
		parts.push(h, body);
		total += BLOCK + padded;
	}
	parts.push(new Uint8Array(BLOCK * 2));
	total += BLOCK * 2;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function field(b: Uint8Array, start: number, len: number): string {
	const s = b.subarray(start, start + len);
	const nul = s.indexOf(0);
	return dec.decode(nul >= 0 ? s.subarray(0, nul) : s);
}

/** Regular files of a tar archive (directories and links are skipped). */
export function untar(
	archive: Uint8Array,
): { name: string; data: Uint8Array }[] {
	const files: { name: string; data: Uint8Array }[] = [];
	let at = 0;
	let longName: string | null = null;
	while (at + BLOCK <= archive.length) {
		const h = archive.subarray(at, at + BLOCK);
		if (h.every((b) => b === 0)) break;
		const size = Number.parseInt(field(h, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(h[156] ?? 0);
		const prefix = field(h, 345, 155);
		const base = field(h, 0, 100);
		const name = longName ?? (prefix ? `${prefix}/${base}` : base);
		const data = archive.subarray(at + BLOCK, at + BLOCK + size);
		longName = null;
		if (type === "L") longName = field(data, 0, data.length);
		else if (type === "0" || type === "\0") files.push({ name, data });
		at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
	}
	return files;
}

/**
 * A tar archive of ONE file whose data streams (mm-210.60): header, the data
 * as it is read, padding, end blocks. `size` must be the data's length; a
 * stream that is shorter or longer errors.
 */
export function tarStream(entry: {
	name: string;
	size: number;
	data: ReadableStream<Uint8Array>;
	mode?: number;
}): ReadableStream<Uint8Array> {
	const reader = entry.data.getReader();
	let sent = 0;
	let started = false;
	let done = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(ctl) {
				if (!started) {
					started = true;
					ctl.enqueue(header(entry.name, entry.size, entry.mode ?? 0o644));
					return;
				}
				if (done) return;
				const r = await reader.read();
				if (!r.done) {
					sent += r.value.byteLength;
					if (sent > entry.size)
						return ctl.error(
							new Error(`tar: ${entry.name}: more than ${entry.size} bytes`),
						);
					ctl.enqueue(r.value);
					return;
				}
				done = true;
				if (sent !== entry.size)
					return ctl.error(
						new Error(`tar: ${entry.name}: ${sent} of ${entry.size} bytes`),
					);
				const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
				ctl.enqueue(new Uint8Array(pad + BLOCK * 2));
				ctl.close();
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 1 },
	);
}

/** Reads exact byte counts from a stream. */
class ByteReader {
	private buf: Uint8Array = new Uint8Array(0);
	private ended = false;
	constructor(
		private readonly r: {
			read(): Promise<{ done: boolean; value?: Uint8Array }>;
			cancel(): Promise<void>;
		},
	) {}

	/** Up to `n` bytes (fewer only at the end), at least 1 unless ended. */
	async some(n: number): Promise<Uint8Array> {
		while (this.buf.length === 0 && !this.ended) {
			const r = await this.r.read();
			if (r.done) this.ended = true;
			else if (r.value) this.buf = r.value;
		}
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(out.length);
		return out;
	}

	/** Exactly `n` bytes, or fewer at the end. */
	async exact(n: number): Promise<Uint8Array> {
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const p = await this.some(n - at);
			if (p.length === 0) break;
			out.set(p, at);
			at += p.length;
		}
		return at === n ? out : out.subarray(0, at);
	}

	async skip(n: number): Promise<void> {
		for (let left = n; left > 0; ) {
			const p = await this.some(Math.min(left, 64 * 1024));
			if (p.length === 0) return;
			left -= p.length;
		}
	}

	cancel() {
		return this.r.cancel().catch(() => {});
	}
}

/**
 * The first regular file of a tar stream, its data streaming; null when the
 * archive has none. Headers before it (pax, long names, directories) are
 * read and skipped.
 */
export async function untarFirst(archive: ReadableStream<Uint8Array>): Promise<{
	name: string;
	size: number;
	data: ReadableStream<Uint8Array>;
} | null> {
	const br = new ByteReader(archive.getReader());
	let longName: string | null = null;
	for (;;) {
		const h = await br.exact(BLOCK);
		if (h.length < BLOCK || h.every((b) => b === 0)) {
			await br.cancel();
			return null;
		}
		const size = Number.parseInt(field(h, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(h[156] ?? 0);
		const prefix = field(h, 345, 155);
		const base = field(h, 0, 100);
		const padded = Math.ceil(size / BLOCK) * BLOCK;
		if (type === "L") {
			const d = await br.exact(padded);
			longName = field(d, 0, size);
			continue;
		}
		if (type !== "0" && type !== "\0") {
			await br.skip(padded);
			longName = null;
			continue;
		}
		const name = longName ?? (prefix ? `${prefix}/${base}` : base);
		let left = size;
		const data = new ReadableStream<Uint8Array>(
			{
				async pull(ctl) {
					if (left === 0) {
						ctl.close();
						await br.cancel();
						return;
					}
					const p = await br.some(Math.min(left, 64 * 1024));
					if (p.length === 0)
						return ctl.error(new Error(`tar: ${name}: archive ends early`));
					left -= p.length;
					ctl.enqueue(p.slice());
				},
				cancel() {
					return br.cancel();
				},
			},
			{ highWaterMark: 1 },
		);
		return { name, size, data };
	}
}
