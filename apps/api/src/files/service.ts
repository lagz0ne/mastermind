/**
 * Files of work items (mm-210.60) on JetStream object stores:
 *
 *   mm_files              <item>/in/<name>    inputs, uploaded by humans
 *   mm_files_<account>    <item>/in/<name>    the inputs, copied in when a
 *                                             runner of <account> asks (stage)
 *                         <item>/out/<name>   outputs the runner made
 *
 * The outputs of an item are in the bucket of the account that holds (or last
 * held) its claim: `assignee` is `<account>/<agent>`.
 *
 * JetStream reserves each bucket's size against APP's max_file
 * (deploy/nats/nats.conf), so the defaults are small; see docs/deploy.md.
 */
import {
	accountFilesBucket,
	type FileInfo,
	Files,
	INPUTS_BUCKET,
	MAX_OBJECT_BYTES,
} from "@mastermind/bus";
import { type Bead, safeFileName } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { streamNames } from "../backup/jetstream.ts";

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export type FilesConfig = {
	/** Largest file, bytes. Default 512 MiB. */
	maxObjectBytes: number;
	/** Size of the inputs bucket, bytes. Default 2 GiB. */
	inputsBytes: number;
	/** Size of each runner account's bucket, bytes. Default 1 GiB. */
	accountBytes: number;
	/** Outputs (and copied inputs) expire after this, ms. Default 30 days. */
	outputTtlMs: number;
};

const positive = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return v && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** MM_FILES_MAX_OBJECT_MIB, MM_FILES_INPUTS_MIB, MM_FILES_ACCOUNT_MIB, MM_FILES_OUTPUT_TTL_DAYS. */
export function filesConfigFromEnv(
	env: Record<string, string | undefined>,
): FilesConfig {
	return {
		maxObjectBytes:
			positive(env.MM_FILES_MAX_OBJECT_MIB, MAX_OBJECT_BYTES / MiB) * MiB,
		inputsBytes: positive(env.MM_FILES_INPUTS_MIB, 2048) * MiB,
		accountBytes: positive(env.MM_FILES_ACCOUNT_MIB, 1024) * MiB,
		outputTtlMs: positive(env.MM_FILES_OUTPUT_TTL_DAYS, 30) * DAY_MS,
	};
}

export type Dir = "in" | "out";

/** A file of an item as the API shows it. */
export type ItemFile = Omit<FileInfo, "name"> & { name: string; dir: Dir };

export { safeFileName };

export const objectName = (item: string, dir: Dir, name: string) =>
	`${item}/${dir}/${name}`;

/** The account of `<account>/<agent>`, or null. */
export const assigneeAccount = (b: Pick<Bead, "assignee">) =>
	b.assignee?.includes("/") ? (b.assignee.split("/")[0] ?? null) : null;

const view = (f: FileInfo, dir: Dir): ItemFile => ({
	...f,
	name: f.name.slice(f.name.indexOf(`/${dir}/`) + dir.length + 2),
	dir,
});

export class ItemFiles {
	private readonly buckets = new Map<string, Promise<Files>>();

	constructor(
		private readonly nc: NatsConnection,
		readonly config: FilesConfig,
	) {}

	/** The inputs bucket (made on first use). */
	inputs(): Promise<Files> {
		return this.bucket(INPUTS_BUCKET, this.config.inputsBytes, 0);
	}

	/** A runner account's bucket (made on first use). */
	account(account: string): Promise<Files> {
		return this.bucket(
			accountFilesBucket(account),
			this.config.accountBytes,
			this.config.outputTtlMs,
		);
	}

	private bucket(name: string, maxBytes: number, ttlMs: number) {
		let b = this.buckets.get(name);
		if (!b) {
			b = Files.open(this.nc, name, {
				create: true,
				maxBytes,
				ttlMs,
				maxObjectBytes: this.config.maxObjectBytes,
			});
			// A failed open is not cached: the next call tries again.
			b.catch(() => this.buckets.delete(name));
			this.buckets.set(name, b);
		}
		return b;
	}

	/** Inputs and outputs of an item. */
	async list(
		item: Pick<Bead, "id" | "assignee">,
	): Promise<{ inputs: ItemFile[]; outputs: ItemFile[] }> {
		const runAccount = assigneeAccount(item);
		const [inputs, outputs] = await Promise.all([
			this.inputs().then((f) => f.list(`${item.id}/in/`)),
			runAccount
				? this.account(runAccount).then((f) => f.list(`${item.id}/out/`))
				: [],
		]);
		return {
			inputs: inputs.map((f) => view(f, "in")),
			outputs: outputs.map((f) => view(f, "out")),
		};
	}

	/** Where a file of the item is: inputs in mm_files, outputs in the claim account's bucket. */
	async source(
		item: Pick<Bead, "id" | "assignee">,
		dir: Dir,
	): Promise<Files | null> {
		if (dir === "in") return this.inputs();
		const runAccount = assigneeAccount(item);
		return runAccount ? this.account(runAccount) : null;
	}

	/**
	 * Copy the item's inputs into `account`'s bucket, for its runner. A copy
	 * with the same sha256 is kept. Returns the inputs.
	 */
	async stage(item: string, account: string): Promise<ItemFile[]> {
		const [src, dst] = await Promise.all([
			this.inputs(),
			this.account(account),
		]);
		const [want, have] = await Promise.all([
			src.list(`${item}/in/`),
			dst.list(`${item}/in/`),
		]);
		const had = new Map(have.map((f) => [f.name, f.sha256]));
		const out: ItemFile[] = [];
		for (const f of want) {
			const copied =
				had.get(f.name) === f.sha256 ? f : await src.copyTo(f.name, dst);
			if (copied) out.push(view(copied, "in"));
		}
		// Inputs deleted on the ticket go from the runner's copy too.
		const wanted = new Set(want.map((f) => f.name));
		for (const f of have)
			if (!wanted.has(f.name)) await dst.delete(f.name).catch(() => {});
		return out;
	}

	/** File count and bytes of every files bucket (operator debug). */
	async usage(): Promise<
		{ bucket: string; files: number; bytes: number; error?: string }[]
	> {
		const buckets = (await streamNames(this.nc))
			.filter((s) => s.startsWith(`OBJ_${INPUTS_BUCKET}`))
			.map((s) => s.slice(4))
			.sort();
		return Promise.all(
			buckets.map(async (bucket) => {
				try {
					const files = await Files.open(this.nc, bucket);
					return { bucket, ...(await files.usage()) };
				} catch (error) {
					return { bucket, files: 0, bytes: 0, error: String(error) };
				}
			}),
		);
	}
}
