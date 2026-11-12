// Files of an item (mm-210.60): list, upload with progress, delete.
// Downloads are plain links (itemFileUrl).
import type { ItemFile, ItemFilesReply } from "@mastermind/core";
import { ApiError, csrfToken } from "../work/api.ts";

const filesPath = (id: string) => `/api/items/${encodeURIComponent(id)}/files`;

async function errorOf(res: { status: number; text(): Promise<string> }) {
	const body = await res.text().catch(() => "");
	let msg = `HTTP ${res.status}`;
	try {
		const j = JSON.parse(body) as { error?: string; detail?: string };
		msg = j.detail ?? j.error ?? msg;
	} catch {}
	return new ApiError(res.status, msg);
}

export async function listFiles(id: string): Promise<ItemFilesReply> {
	const res = await fetch(filesPath(id));
	if (!res.ok) throw await errorOf(res);
	return (await res.json()) as ItemFilesReply;
}

export async function deleteInput(id: string, name: string): Promise<void> {
	const token = await csrfToken();
	const res = await fetch(`${filesPath(id)}/in/${encodeURIComponent(name)}`, {
		method: "DELETE",
		headers: token ? { "x-csrf-token": token } : {},
	});
	if (!res.ok && res.status !== 404) throw await errorOf(res);
}

export type Upload = { done: Promise<ItemFile>; abort(): void };

/**
 * Upload one file as the raw body (the api streams it). XMLHttpRequest, not
 * fetch: fetch cannot report upload progress.
 */
export function uploadFile(
	id: string,
	file: File,
	onProgress: (sent: number, total: number) => void,
): Upload {
	const xhr = new XMLHttpRequest();
	const done = csrfToken().then(
		(token) =>
			new Promise<ItemFile>((resolve, reject) => {
				xhr.open(
					"POST",
					`${filesPath(id)}?name=${encodeURIComponent(file.name)}`,
				);
				xhr.setRequestHeader(
					"content-type",
					file.type || "application/octet-stream",
				);
				if (token) xhr.setRequestHeader("x-csrf-token", token);
				xhr.upload.onprogress = (e) =>
					onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
				xhr.onload = () => {
					if (xhr.status === 201) resolve(JSON.parse(xhr.responseText));
					else
						void errorOf({
							status: xhr.status,
							text: async () => xhr.responseText,
						}).then(reject);
				};
				xhr.onerror = () => reject(new ApiError(0, "upload failed"));
				xhr.onabort = () => reject(new ApiError(0, "cancelled"));
				xhr.send(file);
			}),
	);
	return { done, abort: () => xhr.abort() };
}
