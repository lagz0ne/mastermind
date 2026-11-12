/**
 * Files of a work item (mm-210.60): inputs uploaded on the ticket go into the
 * box at INPUTS_DIR; outputs the box made come back for download.
 *
 *   GET    /api/items/:id/files               -> ItemFilesReply
 *   POST   /api/items/:id/files?name=<name>   raw body -> ItemFile (201)
 *   GET    /api/items/:id/files/:dir/:name    the file (attachment)
 *   DELETE /api/items/:id/files/in/:name      -> 204
 */

export type FileDir = "in" | "out";

export type ItemFile = {
	name: string;
	dir: FileDir;
	size: number;
	/** Lower-case hex. */
	sha256: string;
	/** ISO 8601. */
	mtime: string;
	contentType?: string;
};

export type ItemFilesReply = {
	inputs: ItemFile[];
	outputs: ItemFile[];
	/** Largest file the api takes, bytes. */
	maxBytes: number;
};

/** Where the inputs are inside the box. */
export const INPUTS_DIR = "/workspace/.mastermind/in";
/** Where the agent puts files that should come out of the box. */
export const OUTPUTS_DIR = "/workspace/.mastermind/out";

/** The download path of a file. */
export const itemFileUrl = (item: string, f: Pick<ItemFile, "dir" | "name">) =>
	`/api/items/${encodeURIComponent(item)}/files/${f.dir}/${encodeURIComponent(f.name)}`;

/** 1536 -> "1.5 KiB". */
export function formatBytes(n: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return i === 0
		? `${n} B`
		: `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
