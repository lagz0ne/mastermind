/**
 * What a runner asks about the files of the item it holds (mm-210.60):
 *
 *   mm.u.<account>.f.<bead>.stage  {}                -> {inputs: ItemFile[]}
 *       copies the item's inputs into mm_files_<account>; the runner then
 *       reads them from its own bucket
 *   mm.u.<account>.f.<bead>.out    {names: string[]} -> {outputs: ItemFile[]}
 *       the runner put these outputs in mm_files_<account>; each one that is
 *       there goes on the timeline as 'file out: <name> (<size>)'
 *
 * Only the claim holder's account: `forbidden` otherwise. The subject's
 * account is the caller's (the auth callout scopes it to mm.u.<account>.>).
 */
import {
	BusError,
	type FilesVerb,
	parseSubject,
	patterns,
	SERVICE_QUEUE,
	serve,
} from "@mastermind/bus";
import { formatBytes, type ItemFile } from "@mastermind/core";
import { NotFound } from "@mastermind/work";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { BeadsStore } from "../beads/routes.ts";
import {
	assigneeAccount,
	type ItemFiles,
	objectName,
	safeFileName,
} from "./service.ts";

export type StageReply = { inputs: ItemFile[] };
export type OutRequest = { names: string[] };
export type OutReply = { outputs: ItemFile[] };

const MAX_OUT_NAMES = 100;

export function serveFiles(
	nc: NatsConnection,
	files: ItemFiles,
	beads: Pick<BeadsStore, "get" | "comment">,
	onError?: (error: unknown) => void,
): Subscription[] {
	const holder = async (subject: string, verb: FilesVerb) => {
		const s = parseSubject(subject);
		if (s?.kind !== "files" || s.verb !== verb)
			throw new BusError("bad_request", "not a files subject");
		const bead = await beads.get(s.bead).catch((error) => {
			if (error instanceof NotFound)
				throw new BusError("not_found", `no item ${s.bead}`);
			throw error;
		});
		if (assigneeAccount(bead) !== s.account)
			throw new BusError(
				"forbidden",
				`${s.bead} is not held by account ${s.account}`,
			);
		return { bead, account: s.account };
	};
	const opts = { onError: (e: unknown) => onError?.(e) };
	return [
		serve<unknown, StageReply>(
			nc,
			patterns.files("stage"),
			SERVICE_QUEUE,
			async (_req, msg) => {
				const { bead, account } = await holder(msg.subject, "stage");
				return { inputs: await files.stage(bead.id, account) };
			},
			opts,
		),
		serve<OutRequest, OutReply>(
			nc,
			patterns.files("out"),
			SERVICE_QUEUE,
			async (req, msg) => {
				const { bead, account } = await holder(msg.subject, "out");
				const names = Array.isArray(req?.names) ? req.names : null;
				if (
					!names ||
					names.length > MAX_OUT_NAMES ||
					!names.every((n) => typeof n === "string" && safeFileName(n) === n)
				)
					throw new BusError(
						"bad_request",
						`names: up to ${MAX_OUT_NAMES} plain file names`,
					);
				const bucket = await files.account(account);
				const outputs: ItemFile[] = [];
				for (const name of names) {
					const info = await bucket.info(objectName(bead.id, "out", name));
					if (!info) continue;
					outputs.push({ ...info, name, dir: "out" });
					await beads
						.comment(
							bead.id,
							bead.assignee ?? account,
							`file out: ${name} (${formatBytes(info.size)})`,
						)
						.catch((error) => onError?.(error));
				}
				return { outputs };
			},
			opts,
		),
	];
}
