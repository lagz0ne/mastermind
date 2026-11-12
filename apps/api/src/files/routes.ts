/**
 * Files of a work item over HTTP (mm-210.60), with the browser session. Bodies
 * stream both ways: the api never holds a whole file.
 *
 *   GET    /api/items/:id/files               {inputs, outputs, maxBytes}
 *   POST   /api/items/:id/files?name=<name>   raw body (Content-Type kept;
 *                                             optional X-Sha256 hex) -> 201
 *                                             ItemFile; 413 over the limit
 *   GET    /api/items/:id/files/:dir/:name    the file, as an attachment
 *   DELETE /api/items/:id/files/in/:name      204; outputs are not deleted
 *
 * 404 when the item does not exist; 503 while NATS is not ready.
 */
import { BusError } from "@mastermind/bus";
import {
	type Bead,
	type FileDir,
	formatBytes,
	type ItemFilesReply,
} from "@mastermind/core";
import { NotFound } from "@mastermind/work";
import type { RequireAccount } from "../auth/session.ts";
import type { BeadsStore } from "../beads/routes.ts";
import { type ItemFiles, objectName, safeFileName } from "./service.ts";

export type FilesRoutesOptions = {
	/** Null while NATS is not ready: 503. */
	files: () => ItemFiles | null;
	/** Null without a work store: 503. */
	beads: Pick<BeadsStore, "get" | "comment"> | null;
	requireAccount: RequireAccount;
	onError?: (error: unknown) => void;
};

type Req = Request & { params?: Record<string, string> };

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

/** RFC 6266 attachment header with a UTF-8 file name. */
export function attachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function filesRoutes(opts: FilesRoutesOptions) {
	const guarded =
		(
			fn: (
				req: Req,
				ctx: { account: string; files: ItemFiles; item: Bead },
			) => Promise<Response>,
		) =>
		async (req: Req): Promise<Response> => {
			const who = await opts.requireAccount(req);
			if (who instanceof Response) return who;
			const files = opts.files();
			if (!files || !opts.beads)
				return fail(503, "files are not ready: NATS is starting");
			let item: Bead;
			try {
				item = await opts.beads.get(decodeURIComponent(req.params?.id ?? ""));
			} catch (error) {
				if (error instanceof NotFound) return fail(404, "no such item");
				opts.onError?.(error);
				return fail(503, "files unavailable");
			}
			try {
				return await fn(req, { account: who, files, item });
			} catch (error) {
				if (error instanceof BusError && error.code === "bad_request")
					return fail(
						/larger than the limit/.test(error.message) ? 413 : 400,
						error.message,
					);
				opts.onError?.(error);
				return fail(503, "files unavailable");
			}
		};

	const dirOf = (req: Req): FileDir | null =>
		req.params?.dir === "in" || req.params?.dir === "out"
			? req.params.dir
			: null;
	const nameOf = (req: Req) =>
		safeFileName(decodeURIComponent(req.params?.name ?? ""));

	return {
		"/api/items/:id/files": {
			GET: guarded(async (_req, { files, item }) => {
				const reply: ItemFilesReply = {
					...(await files.list(item)),
					maxBytes: files.config.maxObjectBytes,
				};
				return json(reply);
			}),
			POST: guarded(async (req, { account, files, item }) => {
				const name = safeFileName(
					new URL(req.url).searchParams.get("name") ?? "",
				);
				if (!name) return fail(400, "name is required (?name=<file name>)");
				if (!req.body) return fail(400, "the body is the file");
				const max = files.config.maxObjectBytes;
				const length = req.headers.get("content-length");
				const size = length === null ? undefined : Number(length);
				if (size !== undefined && !(size >= 0))
					return fail(400, "bad content-length");
				if (size !== undefined && size > max)
					return fail(413, `larger than the limit of ${formatBytes(max)}`);
				const sha256 = req.headers.get("x-sha256")?.trim() || undefined;
				if (sha256 && !/^[0-9a-fA-F]{64}$/.test(sha256))
					return fail(400, "x-sha256 must be 64 hex digits");
				const contentType =
					req.headers.get("content-type")?.slice(0, 200) || undefined;
				const inputs = await files.inputs();
				const info = await inputs.put(
					objectName(item.id, "in", name),
					req.body,
					{
						...(size !== undefined ? { size } : {}),
						...(sha256 ? { sha256 } : {}),
						...(contentType ? { contentType } : {}),
					},
				);
				await opts.beads
					?.comment(
						item.id,
						account,
						`file in: ${name} (${formatBytes(info.size)})`,
					)
					.catch((error) => opts.onError?.(error));
				return json({ ...info, name, dir: "in" }, 201);
			}),
		},
		"/api/items/:id/files/:dir/:name": {
			GET: guarded(async (req, { files, item }) => {
				const dir = dirOf(req);
				const name = nameOf(req);
				if (!dir || !name) return fail(404, "no such file");
				const src = await files.source(item, dir);
				const got = await src?.get(objectName(item.id, dir, name));
				if (!got) return fail(404, "no such file");
				return new Response(got.data, {
					headers: {
						"content-type": got.info.contentType ?? "application/octet-stream",
						// Bun sends a streamed body chunked and drops this; x-file-size stays.
						"content-length": String(got.info.size),
						"x-file-size": String(got.info.size),
						"content-disposition": attachment(name),
						// Uploaded content never runs as a page of this origin.
						"content-security-policy": "sandbox",
						"x-content-type-options": "nosniff",
						"cache-control": "private, no-store",
						"x-sha256": got.info.sha256,
					},
				});
			}),
			DELETE: guarded(async (req, { account, files, item }) => {
				const name = nameOf(req);
				if (dirOf(req) !== "in") return fail(400, "only inputs can be deleted");
				if (!name) return fail(404, "no such file");
				const inputs = await files.inputs();
				if (!(await inputs.delete(objectName(item.id, "in", name))))
					return fail(404, "no such file");
				await opts.beads
					?.comment(item.id, account, `file removed: ${name}`)
					.catch((error) => opts.onError?.(error));
				return new Response(null, { status: 204 });
			}),
		},
	};
}
