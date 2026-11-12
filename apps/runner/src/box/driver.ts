/**
 * The box driver: how the runner makes, uses and deletes a throwaway box for
 * one task (human decision A, 2026-11-11: boxes run on the runner machine,
 * Docker first, behind this interface so a hosted driver can come later).
 *
 *   ensureImage(recipe) -> image   (cached by recipe hash: base image + tools)
 *   create(spec)        -> Box     (started, with limits, network and labels)
 *   box.exec / copyIn / copyOut / logs
 *   box.destroy()                  (always; a startup sweep catches crashes)
 */
import type { ModelAuth } from "./proxy.ts";

/** What goes into the box image. Built once per {@link imageHash}. */
export type ImageRecipe = {
	/** Base image, for example `ghcr.io/getpaseo/paseo:0.15.4`. */
	image: string;
	/** Shell lines baked into a child image, run as root. */
	tools?: string[];
	/** A precomputed hash of image + tools (the environment's recipeHash). */
	hash?: string;
};

export type BoxLimits = {
	/** CPUs, for example 2 or 0.5. */
	cpu?: number;
	memoryMb?: number;
};

/** `open`: the default network. `none`: no network. `allow`: listed hosts only. */
export type BoxNetwork = "open" | "none" | { allow: string[] };

export type BoxSpec = {
	/** Image from {@link BoxDriver.ensureImage}. */
	image: string;
	/** Unique container name. */
	name: string;
	/** Labels that let the runner find its boxes after a crash. */
	labels: Record<string, string>;
	limits?: BoxLimits;
	network?: BoxNetwork;
	/** Command to keep the box alive; default: the image's own. */
	cmd?: string[];
	/** Box-wide environment. Not for secret values: use exec env or files. */
	env?: Record<string, string>;
	/** OCI runtime name of the engine, for example `runsc` (gVisor). Absent: the engine's default. */
	runtime?: string;
	/**
	 * The model credential (mm-210.70). The driver keeps the value OUT of the
	 * box: a proxy box next to it adds the auth header, and the box gets
	 * ANTHROPIC_BASE_URL plus a placeholder (proxy.ts modelEnv). Network
	 * `none`: no route, the box gets nothing.
	 */
	model?: ModelAuth;
	/**
	 * Host directories bind-mounted into the box (mm-210.83: the work copy of
	 * the code at /workspace). Read-write; on SELinux relabelled for this box.
	 */
	mounts?: BoxMount[];
};

/** One host directory in the box. `source` is an absolute path on the engine's host. */
export type BoxMount = { source: string; target: string };

/** The engine runtime of each environment runtime (mm-210.63). */
export const ENGINE_RUNTIME = { gvisor: "runsc" } as const;

export type ExecOptions = {
	env?: Record<string, string>;
	workdir?: string;
	/** Default: the image's user. */
	user?: string;
	/** Abort kills nothing by itself: destroy the box to stop the command. */
	signal?: AbortSignal;
};

export type ExecResult = { code: number; stdout: string; stderr: string };

export type BoxInfo = {
	id: string;
	name: string;
	labels: Record<string, string>;
};

export interface Box {
	readonly id: string;
	readonly name: string;
	exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
	/** Put files into directory `dir` of the box (it must exist). */
	copyIn(
		dir: string,
		files: { name: string; data: string | Uint8Array; mode?: number }[],
	): Promise<void>;
	/** The regular files under `path` (a file or a directory), as a tar archive. */
	copyOut(path: string): Promise<Uint8Array>;
	/** Stream one file into directory `dir` (it must exist); never all in memory. */
	copyInStream?(
		dir: string,
		file: {
			name: string;
			size: number;
			data: ReadableStream<Uint8Array>;
			mode?: number;
		},
	): Promise<void>;
	/** Stream the regular file at `path` out; null when there is none. */
	copyOutStream?(
		path: string,
	): Promise<{ size: number; data: ReadableStream<Uint8Array> } | null>;
	/**
	 * Re-point the network allow list of a box made with one (network phases,
	 * mm-210.63). Resolves after the proxy applies it and has closed the
	 * connections the new list does not allow. Absent: the driver cannot.
	 */
	setAllow?(allow: string[]): Promise<void>;
	/** The tail of the box's own output (its main process). */
	logs(tail?: number): Promise<string>;
	/** Stop and delete the box and its anonymous volumes. Never throws on "gone". */
	destroy(): Promise<void>;
}

export interface BoxDriver {
	/** For logs and doctor, for example `docker unix:///run/docker.sock`. */
	readonly name: string;
	/** Is the engine reachable? Throws a {@link BoxError} with a fix when not. */
	ping(): Promise<string>;
	/**
	 * The OCI runtimes the engine can start boxes with (for example `runc`,
	 * `runsc`), only those that are installed. Absent: the driver cannot tell.
	 */
	runtimes?(): Promise<string[]>;
	/** The image to start boxes from; pulls and builds when needed. */
	ensureImage(recipe: ImageRecipe): Promise<string>;
	create(spec: BoxSpec): Promise<Box>;
	/** Boxes with all of these labels. */
	list(labels: Record<string, string>): Promise<BoxInfo[]>;
	/** Delete a box by id; no error when it is already gone. */
	remove(id: string): Promise<void>;
	/**
	 * Empty the host directory `source` as root in a short box of `image`
	 * (mm-210.83: a work copy that still holds files of the box user, after a
	 * box that was killed before it gave them back). Absent: the driver cannot.
	 */
	wipe?(source: string, image: string): Promise<void>;
}

export class BoxError extends Error {
	override name = "BoxError";
}

/** Labels on every box. */
export const BOX_LABEL = {
	runner: "mastermind.runner",
	item: "mastermind.item",
	execution: "mastermind.execution",
} as const;

/** Stable short hash of what goes into the image. */
export function imageHash(recipe: ImageRecipe): string {
	if (recipe.hash) return recipe.hash;
	const h = new Bun.CryptoHasher("sha256");
	h.update(JSON.stringify({ image: recipe.image, tools: recipe.tools ?? [] }));
	return h.digest("hex").slice(0, 16);
}
