// JetStream snapshot and restore through the raw $JS.API (the nats.js clients do not have them).
// The server protocol, as the nats CLI uses it:
//   snapshot: subscribe to an inbox, request $JS.API.STREAM.SNAPSHOT.<stream>
//             {deliver_subject, chunk_size, jsck}. The server sends the stream (an s2-compressed
//             tar) in chunks; each chunk has a reply subject, and replying to it is the flow
//             control ack. An empty message ends it; a status header >= 400 on it is an error.
//   restore:  request $JS.API.STREAM.RESTORE.<stream> {config, state}; the reply names a
//             deliver_subject. Send each chunk there as a request (the reply is the ack), then an
//             empty request: its reply is the stream info of the restored stream.
import { createInbox, type Msg, type NatsConnection } from "@nats-io/nats-core";

const API = "$JS.API";
const TIMEOUT_MS = 30_000;

export type StreamConfig = { name: string } & Record<string, unknown>;
export type StreamState = {
	messages: number;
	bytes: number;
	first_seq: number;
	last_seq: number;
} & Record<string, unknown>;
export type StreamInfo = { config: StreamConfig; state: StreamState };

export type AccountUsage = {
	/** Bytes of file storage in use. */
	storage: number;
	/** The account's file storage limit in bytes; null when there is none. */
	maxStorage: number | null;
	streams: number;
};

type ApiError = { code: number; err_code?: number; description: string };

export class JetStreamApiError extends Error {
	constructor(
		readonly subject: string,
		readonly api: ApiError,
	) {
		super(`${subject}: ${api.description} (${api.err_code ?? api.code})`);
	}
}

async function call<T>(
	nc: NatsConnection,
	subject: string,
	body: unknown = {},
	timeout = TIMEOUT_MS,
): Promise<T> {
	const m = await nc.request(`${API}.${subject}`, JSON.stringify(body), {
		timeout,
	});
	const reply = m.json<T & { error?: ApiError }>();
	if (reply.error) throw new JetStreamApiError(subject, reply.error);
	return reply;
}

/** Every stream name of the account (KV buckets are streams named KV_<bucket>). */
export async function streamNames(nc: NatsConnection): Promise<string[]> {
	const names: string[] = [];
	for (;;) {
		const page = await call<{ streams: string[] | null; total: number }>(
			nc,
			"STREAM.NAMES",
			{ offset: names.length },
		);
		names.push(...(page.streams ?? []));
		if (!page.streams?.length || names.length >= page.total)
			return names.sort();
	}
}

export async function streamInfo(
	nc: NatsConnection,
	name: string,
): Promise<StreamInfo | null> {
	try {
		return await call<StreamInfo>(nc, `STREAM.INFO.${name}`);
	} catch (error) {
		// 10059: stream not found
		if (error instanceof JetStreamApiError && error.api.err_code === 10059)
			return null;
		throw error;
	}
}

export async function deleteStream(
	nc: NatsConnection,
	name: string,
): Promise<void> {
	await call(nc, `STREAM.DELETE.${name}`);
}

export async function accountUsage(nc: NatsConnection): Promise<AccountUsage> {
	const info = await call<{
		storage: number;
		streams: number;
		limits?: { max_storage?: number };
	}>(nc, "INFO");
	const max = info.limits?.max_storage ?? -1;
	return {
		storage: info.storage,
		maxStorage: max > 0 ? max : null,
		streams: info.streams,
	};
}

/**
 * Snapshot one stream (with its durable consumers) into `onChunk`, chunk by chunk.
 * Returns the config and state the server snapshotted.
 */
export async function snapshotStream(
	nc: NatsConnection,
	name: string,
	onChunk: (chunk: Uint8Array) => unknown,
	opts: { chunkSize?: number; idleMs?: number } = {},
): Promise<StreamInfo> {
	const inbox = createInbox();
	const sub = nc.subscribe(inbox);
	const idleMs = opts.idleMs ?? TIMEOUT_MS;
	try {
		const info = await call<StreamInfo>(nc, `STREAM.SNAPSHOT.${name}`, {
			deliver_subject: inbox,
			chunk_size: opts.chunkSize ?? 128 * 1024,
			jsck: true,
		});
		const it = sub[Symbol.asyncIterator]();
		for (;;) {
			const next = await withTimeout(
				it.next(),
				idleMs,
				`snapshot of ${name}: no data for ${idleMs}ms`,
			);
			if (next.done) throw new Error(`snapshot of ${name}: inbox closed`);
			const m: Msg = next.value;
			if (m.data.length === 0) {
				const code = m.headers?.code ?? 0;
				if (code >= 400)
					throw new Error(
						`snapshot of ${name}: ${code} ${m.headers?.description ?? ""}`.trim(),
					);
				return info;
			}
			await onChunk(m.data);
			if (m.reply) m.respond();
		}
	} finally {
		sub.unsubscribe();
	}
}

/** Restore a snapshot into a stream that must not exist yet. Returns the restored stream. */
export async function restoreStream(
	nc: NatsConnection,
	meta: StreamInfo,
	data: ReadableStream<Uint8Array>,
	opts: { chunkSize?: number } = {},
): Promise<StreamInfo> {
	const name = meta.config.name;
	const { deliver_subject } = await call<{ deliver_subject: string }>(
		nc,
		`STREAM.RESTORE.${name}`,
		{ config: meta.config, state: meta.state },
	);
	const send = async (chunk: Uint8Array) => {
		const m = await nc.request(deliver_subject, chunk, { timeout: TIMEOUT_MS });
		if (m.data.length) {
			const reply = m.json<{ error?: ApiError }>();
			if (reply.error)
				throw new JetStreamApiError(`restore of ${name}`, reply.error);
		}
	};
	const size = opts.chunkSize ?? 128 * 1024;
	let pending = new Uint8Array(0);
	for await (const part of data) {
		const joined = new Uint8Array(pending.length + part.length);
		joined.set(pending);
		joined.set(part, pending.length);
		let at = 0;
		for (; joined.length - at >= size; at += size)
			await send(joined.subarray(at, at + size));
		pending = joined.slice(at);
	}
	if (pending.length) await send(pending);
	// The empty message ends the upload; the server answers when the stream is up.
	const done = await nc.request(deliver_subject, new Uint8Array(0), {
		timeout: 5 * 60_000,
	});
	const reply = done.json<StreamInfo & { error?: ApiError }>();
	if (reply.error)
		throw new JetStreamApiError(`restore of ${name}`, reply.error);
	return reply;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(what)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
