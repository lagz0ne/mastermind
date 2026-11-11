// /environments: named box recipes, list + editor.
// Frame "Environments — box recipe (mm-210.50)" (VWYybImf2j).
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
	formErrors,
	fromForm,
	getEnvironments,
	removeEnvironment,
	saveEnvironments,
	setEnvironment,
	toForm,
} from "./environments.ts";

const input =
	"h-7 w-full min-w-0 rounded-[var(--radius)] border border-input bg-card px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const area =
	"w-full resize-y rounded-[var(--radius)] border border-input bg-card px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const mono = "font-mono";

const OUTPUTS: { kind: EnvForm["outputKind"]; label: string }[] = [
	{ kind: "pr", label: "Pull request" },
	{ kind: "branch", label: "Branch mm/<item>" },
	{ kind: "none", label: "Nothing (answer only)" },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Errors = Partial<Record<keyof EnvForm, string>>;

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
			<span className="pt-1.5 font-medium text-xs">{label}</span>
			<div className="min-w-0">
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

/** A labelled block of fields: Box, In, Out. */
function Group({
	title,
	id,
	children,
}: {
	title: string;
	id: string;
	children: React.ReactNode;
}) {
	return (
		<div
			data-doop-id={id}
			className="mt-3 grid grid-cols-1 gap-x-3 border-foreground border-t sm:grid-cols-[96px_1fr]"
		>
			<span className="label-caps pt-2">{title}</span>
			<div>{children}</div>
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
	errors: Errors;
	onChange: (form: EnvForm) => void;
	onDelete: () => void;
}) {
	const set =
		(key: keyof EnvForm) =>
		(
			e: React.ChangeEvent<
				HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
			>,
		) =>
			onChange({ ...form, [key]: e.target.value });
	const nameError =
		errors.name ??
		(ENV_NAME.test(form.name) ? undefined : "1-64 letters, digits, '_' or '-'");
	const bad = (key: keyof EnvForm) =>
		errors[key] || (key === "name" && nameError) ? "border-destructive" : "";
	const text = (
		key: keyof EnvForm,
		label: string,
		opts: { placeholder?: string; code?: boolean } = {},
	) => (
		<input
			aria-label={label}
			className={cn(input, opts.code && mono, bad(key))}
			placeholder={opts.placeholder}
			value={form[key]}
			onChange={set(key)}
		/>
	);
	const lines = (key: keyof EnvForm, label: string, placeholder: string) => (
		<textarea
			aria-label={label}
			rows={2}
			className={cn(area, mono, bad(key))}
			placeholder={placeholder}
			value={form[key]}
			onChange={set(key)}
		/>
	);
	const unit = (key: keyof EnvForm, label: string, u: string) => (
		<div className="relative">
			{text(key, label)}
			<span className="pointer-events-none absolute top-1.5 right-2 text-[11px] text-muted-foreground">
				{u}
			</span>
		</div>
	);
	return (
		<section data-doop-id="env-editor">
			<div className="flex items-center gap-2 border-foreground border-t-2 border-b py-1.5 text-xs">
				<span className="font-semibold">{form.name || "unnamed"}</span>
				<span className="text-muted-foreground">
					the recipe of a box: one throwaway box per task
				</span>
				<span className="flex-1" />
				<Button size="sm" variant="outline" onClick={onDelete}>
					Delete
				</Button>
			</div>
			<Field label="Name" error={nameError}>
				{text("name", "Name")}
			</Field>
			<Field label="Description" error={errors.description}>
				{text("description", "Description")}
			</Field>

			<Group title="Box" id="env-grp-box">
				<Field
					label="Image"
					error={errors.image}
					hint="Base image. Empty: the default box image."
				>
					{text("image", "Image", {
						placeholder: "default box image",
						code: true,
					})}
				</Field>
				<Field
					label="Tools"
					error={errors.tools}
					hint="One line each. Baked once into a cached image."
				>
					{lines("tools", "Tools", "RUN apt-get install -y jq")}
				</Field>
				<Field
					label="Setup"
					error={errors.setup}
					hint="One command per line. Runs in each new box, after the checkout."
				>
					{lines("setup", "Setup", "bun install")}
				</Field>
				<Field
					label="Check"
					error={errors.check}
					hint="Must pass before the agent starts; a failure ends the task with the reason."
				>
					{lines("check", "Check", "bun test")}
				</Field>
				<Field
					label="Limits"
					error={errors.cpu ?? errors.memoryMb ?? errors.timeoutMin}
				>
					<div className="grid grid-cols-3 gap-2">
						{unit("cpu", "CPU", "cpu")}
						{unit("memoryMb", "Memory (MB)", "MB")}
						{unit("timeoutMin", "Timeout (minutes)", "min")}
					</div>
				</Field>
				<Field
					label="Network"
					error={errors.network}
					hint="open, or the allowed hosts (host, host:port, *.host)."
				>
					{text("network", "Network", { placeholder: "open", code: true })}
				</Field>
			</Group>

			<Group title="In" id="env-grp-in">
				<Field
					label="Repo and ref"
					error={errors.repo ?? errors.ref}
					hint="A label ref:<branch> on the item overrides the ref."
				>
					<div className="grid grid-cols-[1fr_140px] gap-2">
						{text("repo", "Repo", {
							placeholder: "https://github.com/org/repo.git",
							code: true,
						})}
						{text("ref", "Ref", { placeholder: "main", code: true })}
					</div>
				</Field>
				<Field
					label="Secrets"
					error={errors.secrets}
					hint="Names only. The values stay on the runner machine."
				>
					{text("secrets", "Secrets", { placeholder: "GH_TOKEN", code: true })}
				</Field>
				<Field
					label="Provider"
					error={errors.provider ?? errors.providerAuth ?? errors.mode}
					hint="Provider, the secret with its login, and the mode."
				>
					<div className="grid grid-cols-3 gap-2">
						{text("provider", "Provider", { placeholder: "claude" })}
						{text("providerAuth", "Provider login secret", {
							placeholder: "CLAUDE_TOKEN",
							code: true,
						})}
						{text("mode", "Mode", { placeholder: "mode (optional)" })}
					</div>
				</Field>
				<Field
					label="Requires"
					error={errors.requires}
					hint="Capabilities the runner must have, for example docker."
				>
					{text("requires", "Requires", { code: true })}
				</Field>
			</Group>

			<Group title="Out" id="env-grp-out">
				<Field
					label="Output"
					error={errors.outputKind ?? errors.outputBase}
					hint="Pull request, branch mm/<item>, or nothing (answer only). Right: base branch."
				>
					<div className="grid grid-cols-[1fr_140px] gap-2">
						<select
							aria-label="Output"
							className={cn(input, bad("outputKind"))}
							value={form.outputKind}
							onChange={set("outputKind")}
						>
							{OUTPUTS.map((o) => (
								<option key={o.kind} value={o.kind}>
									{o.label}
								</option>
							))}
						</select>
						{text("outputBase", "Base branch", {
							placeholder: "the ref",
							code: true,
						})}
					</div>
				</Field>
				<Field
					label="Instructions"
					error={errors.instructions}
					hint="Added to every prompt."
				>
					<textarea
						aria-label="Instructions"
						rows={2}
						className={area}
						value={form.instructions}
						onChange={set("instructions")}
					/>
				</Field>
			</Group>
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
	// A number field holds a word: say so before the round trip.
	const local = form ? Object.keys(formErrors(form)).length > 0 : false;

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
					disabled={dirty === 0 || saving || local}
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
						<span className="label-caps">Environments</span>
						<span className="text-muted-foreground">
							beads use the label env:&lt;name&gt;
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
								<span className="block truncate font-mono text-[11px] text-muted-foreground">
									{e.image || "default image"} · {e.repo || "no repo"} @ {e.ref}
								</span>
							</span>
							<span className="whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
								{e.output.kind} · {e.limits.cpu} cpu
							</span>
						</button>
					))}
				</section>
				{form && (
					<Editor
						form={form}
						errors={{
							...errorsFor(fieldErrors, selected),
							...formErrors(form),
						}}
						onChange={editForm}
						onDelete={remove}
					/>
				)}
			</div>
		</div>
	);
}
