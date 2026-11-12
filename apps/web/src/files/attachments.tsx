// The Files section of the bead sheet (mm-210.60, frame Pcse2wrOwi): inputs
// the box gets at INPUTS_DIR, and the files the agent handed back.
import {
	formatBytes,
	INPUTS_DIR,
	type ItemFile,
	type ItemFilesReply,
	itemFileUrl,
	OUTPUTS_DIR,
} from "@mastermind/core";
import {
	type DragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteInput, listFiles, type Upload, uploadFile } from "./api.ts";

type Pending = {
	key: number;
	name: string;
	size: number;
	sent: number;
	error?: string;
	upload?: Upload;
};

/** Files picked by the user, split into ones to upload and ones over the limit. */
export function checkFiles(
	files: readonly Pick<File, "name" | "size">[],
	maxBytes: number,
) {
	return files.map((f) =>
		f.size > maxBytes
			? { file: f, error: `larger than the limit of ${formatBytes(maxBytes)}` }
			: { file: f },
	);
}

function FileRow({
	beadId,
	file,
	action,
}: {
	beadId: string;
	file: ItemFile;
	action?: React.ReactNode;
}) {
	return (
		<li className="grid grid-cols-[1fr_110px_64px] items-center gap-2 border-b py-1 text-sm last:border-b-0">
			<a
				href={itemFileUrl(beadId, file)}
				download={file.name}
				className="truncate underline underline-offset-2"
				title={`sha256 ${file.sha256}`}
			>
				{file.name}
			</a>
			<span className="text-right text-[11px] text-muted-foreground">
				{formatBytes(file.size)}
			</span>
			<span className="text-right">{action}</span>
		</li>
	);
}

/** The aside of the Files section heading. */
export const FILES_ASIDE = `inputs go into the box at ${INPUTS_DIR}`;

const Caps = ({ children }: { children: React.ReactNode }) => (
	<h4 className="mt-2.5 mb-0.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-[.06em]">
		{children}
	</h4>
);

/** `version` changes when the item's timeline changes: the list reloads then. */
export function Attachments({
	beadId,
	version,
}: {
	beadId: string;
	version: number;
}) {
	const [files, setFiles] = useState<ItemFilesReply | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending[]>([]);
	const [over, setOver] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const keys = useRef(0);

	const reload = useCallback(() => {
		listFiles(beadId)
			.then((r) => {
				setFiles(r);
				setError(null);
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, [beadId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the reload trigger
	useEffect(reload, [reload, version]);

	const patch = (key: number, p: Partial<Pending>) =>
		setPending((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x)));

	const add = (list: FileList | null) => {
		if (!list?.length || !files) return;
		for (const { file, error: tooBig } of checkFiles(
			Array.from(list),
			files.maxBytes,
		)) {
			const key = ++keys.current;
			const item: Pending = {
				key,
				name: file.name,
				size: file.size,
				sent: 0,
			};
			if (tooBig) {
				setPending((all) => [...all, { ...item, error: tooBig }]);
				continue;
			}
			const upload = uploadFile(beadId, file as File, (sent) =>
				patch(key, { sent }),
			);
			setPending((all) => [...all, { ...item, upload }]);
			upload.done
				.then(() => {
					setPending((all) => all.filter((x) => x.key !== key));
					reload();
				})
				.catch((e) =>
					patch(key, {
						error: e instanceof Error ? e.message : String(e),
						upload: undefined,
					}),
				);
		}
	};

	const drop = (e: DragEvent) => {
		e.preventDefault();
		setOver(false);
		add(e.dataTransfer.files);
	};

	const remove = async (name: string) => {
		try {
			await deleteInput(beadId, name);
			reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div data-files>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target; the button inside is the keyboard path */}
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={drop}
				className={cn(
					"flex items-center gap-2 rounded-md border border-input border-dashed p-3 text-muted-foreground text-sm",
					over && "border-foreground bg-muted text-foreground",
				)}
			>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!files}
					onClick={() => input.current?.click()}
				>
					Choose files
				</Button>
				<span>
					or drop them here
					{files ? ` · up to ${formatBytes(files.maxBytes)} each` : ""}
				</span>
				<input
					ref={input}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						add(e.target.files);
						e.target.value = "";
					}}
				/>
			</div>
			{error && (
				<p role="alert" className="mt-1 text-signal text-xs">
					{error}
				</p>
			)}
			{(files?.inputs.length || pending.length) > 0 && (
				<>
					<Caps>Inputs</Caps>
					<ul>
						{files?.inputs.map((f) => (
							<FileRow
								key={f.name}
								beadId={beadId}
								file={f}
								action={
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-muted-foreground"
										onClick={() => remove(f.name)}
									>
										Remove
									</Button>
								}
							/>
						))}
						{pending.map((p) => (
							<li
								key={p.key}
								className="grid grid-cols-[1fr_110px_64px] items-center gap-2 border-b py-1 text-sm last:border-b-0"
							>
								<span className="min-w-0">
									<span className="truncate">{p.name}</span>{" "}
									{p.error ? (
										<span className="text-signal text-[11px]">{p.error}</span>
									) : (
										<span className="mt-1 block h-0.5 overflow-hidden rounded-sm bg-border">
											<i
												className="block h-0.5 bg-foreground"
												style={{
													width: `${p.size ? Math.round((100 * p.sent) / p.size) : 0}%`,
												}}
											/>
										</span>
									)}
								</span>
								<span className="text-right text-[11px] text-muted-foreground">
									{p.error
										? formatBytes(p.size)
										: `${p.size ? Math.round((100 * p.sent) / p.size) : 0}% of ${formatBytes(p.size)}`}
								</span>
								<span className="text-right">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-muted-foreground"
										onClick={() => {
											p.upload?.abort();
											setPending((all) => all.filter((x) => x.key !== p.key));
										}}
									>
										{p.upload ? "Cancel" : "Dismiss"}
									</Button>
								</span>
							</li>
						))}
					</ul>
				</>
			)}
			{files && files.outputs.length > 0 && (
				<>
					<Caps>From the agent</Caps>
					<ul>
						{files.outputs.map((f) => (
							<FileRow
								key={f.name}
								beadId={beadId}
								file={f}
								action={
									<a
										href={itemFileUrl(beadId, f)}
										download={f.name}
										className="text-[11px] text-muted-foreground hover:underline"
									>
										Download
									</a>
								}
							/>
						))}
					</ul>
				</>
			)}
			<p className="mt-1.5 text-[11px] text-muted-foreground">
				Outputs are kept 30 days. The agent puts files to hand back in{" "}
				{OUTPUTS_DIR}.
			</p>
		</div>
	);
}
