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
