/**
 * Files of the item a box runs (mm-210.60), on the runner's own account
 * bucket mm_files_<account> (the auth callout gives it that bucket only):
 *
 *   stage  ask Mastermind to copy the item's inputs into the bucket
 *   read   an input, streamed
 *   write  an output, streamed
 *   out    tell Mastermind which outputs are there (the ticket timeline)
 */
import {
	accountFilesBucket,
	type FileInfo,
	Files,
	request,
	subjects,
} from "@mastermind/bus";
import type { ItemFile } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";

export type BoxFiles = {
	stage(beadId: string): Promise<ItemFile[]>;
	read(
		beadId: string,
		name: string,
	): Promise<{ size: number; data: ReadableStream<Uint8Array> } | null>;
	write(
		beadId: string,
		name: string,
		data: ReadableStream<Uint8Array>,
		meta?: { size?: number; contentType?: string },
	): Promise<FileInfo>;
	out(beadId: string, names: string[]): Promise<ItemFile[]>;
};

/** Staging copies every input; allow time for big ones. */
const STAGE_TIMEOUT_MS = 10 * 60_000;

export function natsBoxFiles(nc: NatsConnection, account: string): BoxFiles {
	let bucket: Promise<Files> | null = null;
	const open = () => {
		if (!bucket) {
			bucket = Files.open(nc, accountFilesBucket(account));
			bucket.catch(() => {
				bucket = null;
			});
		}
		return bucket;
	};
	return {
		async stage(beadId) {
			const r = await request<object, { inputs: ItemFile[] }>(
				nc,
				subjects.files(account, beadId, "stage"),
				{},
				{ timeout: STAGE_TIMEOUT_MS },
			);
			return r.inputs;
		},
		async read(beadId, name) {
			const got = await (await open()).get(`${beadId}/in/${name}`);
			return got ? { size: got.info.size, data: got.data } : null;
		},
		async write(beadId, name, data, meta = {}) {
			return (await open()).put(`${beadId}/out/${name}`, data, meta);
		},
		async out(beadId, names) {
			const r = await request<{ names: string[] }, { outputs: ItemFile[] }>(
				nc,
				subjects.files(account, beadId, "out"),
				{ names },
			);
			return r.outputs;
		},
	};
}
