// /environments: named environments (repo, ref, setup, check, ...), list + editor.
// Frame "Environments (mm-210.30)" (Jwc8-YTZLu).
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	ApiError,
	addEnvironment,
	changes,
	ENV_NAME,
	type EnvForm,
	type Environments,
	type EnvironmentsDoc,
	erroredIndexes,
	errorsFor,
	type FieldError,
	fromForm,
	getEnvironments,
	removeEnvironment,
	saveEnvironments,
	setEnvironment,
	toForm,
} from "./environments.ts";

const input =
	"h-6 w-full rounded-[var(--radius)] border bg-card px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const area =
	"w-full resize-y rounded-[var(--radius)] border bg-card px-1.5 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const mono = "font-mono";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Field({
	label,
	hint,
	error,
	children,
}: {
	label: string;
	hint?: string;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-[120px_1fr] gap-x-3 border-b py-1">
			<span className="pt-1 font-medium text-xs">{label}</span>
			<div>
				{children}
				{error ? (
					<p className="mt-0.5 text-[11px] text-destructive">{error}</p>
				) : hint ? (
					<p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
				) : null}
			</div>
		</div>
	);
}

function Editor({
	form,
	errors,
	onChange,
	onDelete,
}: {
	form: EnvForm;
	errors: Partial<Record<keyof EnvForm, string>>;
	onChange: (form: EnvForm) => void;
	onDelete: () => void;
}) {
	const set =
		(key: keyof EnvForm) =>
		(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			onChange({ ...form, [key]: e.target.value });
	const nameError =
		errors.name ??
		(ENV_NAME.test(form.name) ? undefined : "1-64 letters, digits, '_' or '-'");
	const bad = (key: keyof EnvForm) =>
		errors[key] || (key === "name" && nameError) ? "border-destructive" : "";
	return (
		<section data-doop-id="env-editor">
			<div className="flex items-center gap-2 border-foreground border-t-2 border-b py-1.5 text-xs">
				<span className="font-semibold">{form.name || "unnamed"}</span>
				<span className="text-muted-foreground">
					used when a runner prepares a checkout for a bead
				</span>
				<span className="flex-1" />
				<Button
					size="sm"
					variant="outline"
					className="h-5 px-1.5 text-[11px]"
					onClick={onDelete}
				>
					Delete
				</Button>
			</div>
			<Field label="Name" error={nameError}>
				<input
					aria-label="Name"
					className={cn(input, bad("name"))}
					value={form.name}
					onChange={set("name")}
				/>
			</Field>
			<Field label="Description" error={errors.description}>
				<input
					aria-label="Description"
					className={input}
					value={form.description}
					onChange={set("description")}
				/>
			</Field>
			<Field
				label="Repo and ref"
				error={errors.repo ?? errors.ref}
				hint="A bead label ref:<branch> overrides the ref."
			>
				<div className="grid grid-cols-[1fr_160px] gap-2">
					<input
						aria-label="Repo"
						className={cn(input, mono, bad("repo"))}
						placeholder="https://github.com/org/repo.git"
						value={form.repo}
						onChange={set("repo")}
					/>
					<input
						aria-label="Ref"
						className={cn(input, mono, bad("ref"))}
						placeholder="main"
						value={form.ref}
						onChange={set("ref")}
					/>
				</div>
			</Field>
			<Field
				label="Requires"
				error={errors.requires}
				hint="Capabilities the runner must have, space separated: bun>=1.4 docker"
			>
				<input
					aria-label="Requires"
					className={cn(input, mono, bad("requires"))}
					value={form.requires}
					onChange={set("requires")}
				/>
			</Field>
			<Field
				label="Setup"
				error={errors.setup}
				hint="One command per line. Runs once per checkout, before the agent starts."
			>
				<textarea
					aria-label="Setup"
					rows={3}
					className={cn(area, mono, bad("setup"))}
					placeholder="bun install"
					value={form.setup}
					onChange={set("setup")}
				/>
			</Field>
			<Field
				label="Check"
				error={errors.check}
				hint="One command per line. Runs before every start; a failed check gives the bead back."
			>
				<textarea
					aria-label="Check"
					rows={2}
					className={cn(area, mono, bad("check"))}
					placeholder="bun test"
					value={form.check}
					onChange={set("check")}
				/>
			</Field>
			<Field
				label="Secrets"
				error={errors.secrets}
				hint="Names only, space separated. Never the value."
			>
				<input
					aria-label="Secrets"
					className={cn(input, mono, bad("secrets"))}
					placeholder="GH_TOKEN"
					value={form.secrets}
					onChange={set("secrets")}
				/>
			</Field>
			<Field
				label="Agent"
				error={errors.provider ?? errors.mode}
				hint="A preference: the runner's own rules win."
			>
				<div className="grid grid-cols-2 gap-2">
					<input
						aria-label="Agent provider"
						className={cn(input, bad("provider"))}
						placeholder="provider (optional)"
						value={form.provider}
						onChange={set("provider")}
					/>
					<input
						aria-label="Agent mode"
						className={cn(input, bad("mode"))}
						placeholder="mode (optional)"
						value={form.mode}
						onChange={set("mode")}
					/>
				</div>
			</Field>
			<Field
				label="Instructions"
				error={errors.instructions}
				hint="Added to every prompt for this environment."
			>
				<textarea
					aria-label="Instructions"
					rows={3}
					className={area}
					value={form.instructions}
					onChange={set("instructions")}
				/>
			</Field>
		</section>
	);
}

export function EnvironmentsPage() {
	const [saved, setSaved] = useState<Environments | null>(null);
	const [draft, setDraft] = useState<EnvironmentsDoc | null>(null);
	const [selected, setSelected] = useState(0);
	// The form of the selected environment, kept as typed (lines, spaces).
	const [form, setForm] = useState<EnvForm | null>(null);
	const [conflict, setConflict] = useState<Environments | null>(null);
	const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const reset = useCallback((e: Environments, index = 0) => {
		setSaved(e);
		setDraft({ environments: e.environments });
		const i = Math.min(index, Math.max(e.environments.length - 1, 0));
		setSelected(i);
		const env = e.environments[i];
		setForm(env ? toForm(env) : null);
		setConflict(null);
		setFieldErrors([]);
	}, []);

	const load = useCallback(() => {
		setError(null);
		getEnvironments()
			.then((e) => reset(e))
			.catch((e) => setError(errorText(e)));
	}, [reset]);
	useEffect(load, [load]);

	if (!draft || !saved)
		return (
			<div className="px-4 py-4 text-muted-foreground text-sm">
				{error ?? "Loading environments…"}
			</div>
		);

	const select = (i: number) => {
		setSelected(i);
		const env = draft.environments[i];
		setForm(env ? toForm(env) : null);
	};
	const editForm = (next: EnvForm) => {
		setForm(next);
		setDraft(setEnvironment(draft, selected, fromForm(next)));
	};
	const add = () => {
		const { doc, index } = addEnvironment(draft);
		setDraft(doc);
		setSelected(index);
		setForm(
			toForm(
				doc.environments[index] as NonNullable<
					(typeof doc.environments)[number]
				>,
			),
		);
	};
	const remove = () => {
		const doc = removeEnvironment(draft, selected);
		setDraft(doc);
		setFieldErrors([]);
		const i = Math.min(selected, Math.max(doc.environments.length - 1, 0));
		setSelected(i);
		const env = doc.environments[i];
		setForm(env ? toForm(env) : null);
	};
	const dirty = changes(saved, draft);
	const save = () => {
		setSaving(true);
		setError(null);
		setFieldErrors([]);
		saveEnvironments(draft, saved.revision)
			.then((e) => reset(e, selected))
			.catch((e) => {
				if (e instanceof ApiError && e.status === 409)
					setConflict(e.body.current as Environments);
				else if (e instanceof ApiError && Array.isArray(e.body.errors))
					setFieldErrors(e.body.errors as FieldError[]);
				else setError(errorText(e));
			})
			.finally(() => setSaving(false));
	};
	const failed = erroredIndexes(fieldErrors);

	return (
		<div className="h-full overflow-auto pb-8">
			<div
				className="flex flex-wrap items-baseline gap-4 px-4 pt-4 pb-3"
				data-doop-id="env-head"
			>
				<h1 className="font-bold text-xl tracking-tight">Environments</h1>
				<span className="text-muted-foreground text-xs tabular-nums">
					{draft.environments.length} environments · revision {saved.revision}
				</span>
				<span className="flex-1" />
				{dirty > 0 && (
					<span className="text-muted-foreground text-xs">
						{dirty} unsaved {dirty === 1 ? "change" : "changes"}
					</span>
				)}
				<Button
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
					disabled={dirty === 0 || saving}
					onClick={() => reset(saved, selected)}
				>
					Discard
				</Button>
				<Button
					size="sm"
					className="h-6 px-2 text-xs"
					disabled={dirty === 0 || saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>

			{conflict && (
				<div
					role="alert"
					data-doop-id="env-conflict"
					className="mx-4 mb-3 flex items-center gap-3 border border-destructive border-l-[3px] px-2.5 py-1.5 text-xs"
				>
					<b className="font-semibold text-destructive">Not saved.</b>
					<span>
						Somebody else saved environments first (revision {conflict.revision}
						). Reload to see their change, then apply yours again.
					</span>
					<span className="flex-1" />
					<Button
						size="sm"
						variant="outline"
						className="h-5 px-1.5 text-[11px]"
						onClick={() => reset(conflict, selected)}
					>
						Reload
					</Button>
				</div>
			)}
			{fieldErrors.length > 0 && (
				<p
					role="alert"
					className="mx-4 mb-3 border border-destructive border-l-[3px] px-2.5 py-1.5 text-xs"
				>
					<b className="font-semibold text-destructive">Not saved.</b> Fix the
					marked fields.
				</p>
			)}
			{error && (
				<p
					role="alert"
					className="mx-4 mb-3 border border-destructive px-2.5 py-1.5 text-xs"
				>
					{error}
				</p>
			)}

			<div className="grid grid-cols-1 gap-6 px-4 md:grid-cols-[400px_1fr]">
				<section data-doop-id="env-list">
					<div className="flex items-center gap-2 border-foreground border-t-2 border-b py-1.5 text-xs">
						<span className="font-semibold">Environments</span>
						<span className="text-muted-foreground">
							a bead names one with the label env:&lt;name&gt;
						</span>
						<span className="flex-1" />
						<Button
							size="sm"
							variant="outline"
							className="h-5 px-1.5 text-[11px]"
							onClick={add}
						>
							Add
						</Button>
					</div>
					{draft.environments.length === 0 && (
						<p className="py-2 text-muted-foreground text-xs">
							No environments yet. Until the first save, beads without
							env:&lt;name&gt; run the old way (repo:/ref: labels).
						</p>
					)}
					{draft.environments.map((e, i) => (
						<button
							type="button"
							// biome-ignore lint/suspicious/noArrayIndexKey: names change while typed and may repeat; rows hold no state
							key={i}
							data-doop-id={`env-row-${e.name}`}
							onClick={() => select(i)}
							className={cn(
								"grid min-h-10 w-full grid-cols-[1fr_auto] items-center gap-2 border-b px-2 py-1.5 text-left",
								i === selected &&
									"bg-muted shadow-[inset_3px_0_0_var(--foreground)]",
							)}
						>
							<span className="min-w-0">
								<span
									className={cn(
										"block font-semibold",
										failed.has(i) && "text-destructive",
									)}
								>
									{e.name || "unnamed"}
								</span>
								<span className="block truncate font-mono text-muted-foreground text-xs">
									{e.repo || "no repo"} @ {e.ref}
								</span>
							</span>
							<span className="whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
								{e.setup.length || e.check.length
									? `${e.setup.length} setup · ${e.check.length} check`
									: "no setup"}
							</span>
						</button>
					))}
				</section>
				{form && (
					<Editor
						form={form}
						errors={errorsFor(fieldErrors, selected)}
						onChange={editForm}
						onDelete={remove}
					/>
				)}
			</div>
		</div>
	);
}
