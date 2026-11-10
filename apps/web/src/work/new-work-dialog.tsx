import type { NewWork, Priority } from "@mastermind/core";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "./api.ts";

export const WORK_TYPES = ["task", "bug", "feature", "chore"] as const;

export type WorkForm = {
	title: string;
	description: string;
	acceptance: string;
	type: string;
	priority: Priority;
	labels: string;
	repo: string;
	ref: string;
};

export const emptyForm: WorkForm = {
	title: "",
	description: "",
	acceptance: "",
	type: "task",
	priority: 2,
	labels: "",
	repo: "",
	ref: "",
};

/** The POST /api/beads body; labels split on spaces and commas. */
export function toNewWork(form: WorkForm): NewWork {
	const work: NewWork = {
		title: form.title.trim(),
		type: form.type,
		priority: form.priority,
		labels: form.labels.split(/[\s,]+/).filter(Boolean),
	};
	if (form.description.trim()) work.description = form.description.trim();
	if (form.acceptance.trim()) work.acceptance = form.acceptance.trim();
	if (form.repo.trim()) {
		work.env = { repo: form.repo.trim() };
		if (form.ref.trim()) work.env.ref = form.ref.trim();
	}
	return work;
}

/** True when the key press is typing in a field, not a shortcut. */
function typing(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	return (
		!!el &&
		(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
	);
}

const field =
	"w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const label = "text-[12px] text-muted-foreground";

/** "New work" in the top bar. Shortcut: n. Submit: Enter in the title, or ⌘/Ctrl+Enter. */
export function NewWorkButton() {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<WorkForm>(emptyForm);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const navigate = useNavigate();

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
			if (typing(e.target)) return;
			e.preventDefault();
			setOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const set =
		<K extends keyof WorkForm>(key: K) =>
		(value: WorkForm[K]) =>
			setForm((f) => ({ ...f, [key]: value }));

	const submit = async (e?: FormEvent) => {
		e?.preventDefault();
		if (busy || !form.title.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const bead = await api.create(toNewWork(form));
			setOpen(false);
			setForm(emptyForm);
			navigate({ to: "/board/$beadId", params: { beadId: bead.id } });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>
				<Button size="sm" title="New work (n)">
					New work
				</Button>
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
				<Dialog.Content className="fixed top-[10vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-md border bg-background p-4 shadow-lg">
					<Dialog.Title className="font-bold text-base">New work</Dialog.Title>
					<Dialog.Description className="mb-3 text-muted-foreground text-xs">
						Creates a bead. Routing puts it on a queue; a runner takes it.
					</Dialog.Description>
					<form
						onSubmit={submit}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
						}}
						className="grid grid-cols-2 gap-x-3 gap-y-2"
					>
						<label className="col-span-2 flex flex-col gap-1">
							<span className={label}>Title</span>
							<input
								// biome-ignore lint/a11y/noAutofocus: a dialog opened to type in
								autoFocus
								required
								maxLength={300}
								value={form.title}
								onChange={(e) => set("title")(e.target.value)}
								className={field}
								placeholder="Fix the login redirect"
							/>
						</label>
						<label className="col-span-2 flex flex-col gap-1">
							<span className={label}>Description</span>
							<textarea
								rows={3}
								value={form.description}
								onChange={(e) => set("description")(e.target.value)}
								className={`${field} resize-y`}
							/>
						</label>
						<label className="col-span-2 flex flex-col gap-1">
							<span className={label}>Acceptance (optional)</span>
							<textarea
								rows={2}
								value={form.acceptance}
								onChange={(e) => set("acceptance")(e.target.value)}
								className={`${field} resize-y`}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className={label}>Type</span>
							<select
								value={form.type}
								onChange={(e) => set("type")(e.target.value)}
								className={field}
							>
								{WORK_TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span className={label}>Priority</span>
							<select
								value={form.priority}
								onChange={(e) =>
									set("priority")(Number(e.target.value) as Priority)
								}
								className={field}
							>
								{[0, 1, 2, 3, 4].map((p) => (
									<option key={p} value={p}>
										P{p}
									</option>
								))}
							</select>
						</label>
						<label className="col-span-2 flex flex-col gap-1">
							<span className={label}>Labels (space or comma)</span>
							<input
								value={form.labels}
								onChange={(e) => set("labels")(e.target.value)}
								className={`${field} font-mono`}
								placeholder="api req:bun"
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className={label}>Repo (optional)</span>
							<input
								value={form.repo}
								onChange={(e) => set("repo")(e.target.value)}
								className={`${field} font-mono`}
								placeholder="https://github.com/org/repo.git"
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className={label}>Ref</span>
							<input
								value={form.ref}
								onChange={(e) => set("ref")(e.target.value)}
								className={`${field} font-mono`}
								placeholder="main"
								disabled={!form.repo.trim()}
							/>
						</label>
						<div className="col-span-2 mt-1 flex items-center gap-2">
							<Button type="submit" disabled={busy || !form.title.trim()}>
								{busy ? "Creating…" : "Create"}
							</Button>
							<Dialog.Close asChild>
								<Button type="button" variant="ghost">
									Cancel
								</Button>
							</Dialog.Close>
							<span className="text-[11px] text-muted-foreground">
								⌘/Ctrl+Enter
							</span>
							{error && (
								<span role="alert" className="ml-auto text-signal text-xs">
									{error}
								</span>
							)}
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
