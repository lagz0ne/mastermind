// /routing: queues with members, ordered rules, try a bead. Frame "Routing" (XkbBRGLujh).
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	ACCOUNT_ID,
	ApiError,
	addQueue,
	addRule,
	changes,
	type Explanation,
	getRouting,
	moveRule,
	parseLabels,
	parseTry,
	QUEUE_NAME,
	type Queue,
	type Routing,
	type RoutingDoc,
	type Rule,
	removeQueue,
	removeRule,
	saveRouting,
	setQueue,
	setRule,
	tryRouting,
} from "./routing.ts";

const input =
	"h-6 rounded-[var(--radius)] border bg-card px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const chip =
	"inline-flex h-4 items-center gap-1 rounded-[var(--radius)] bg-muted px-1.5 font-medium text-[11px]";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Section({
	title,
	hint,
	action,
	children,
	id,
}: {
	title: string;
	hint: string;
	action?: React.ReactNode;
	children: React.ReactNode;
	id: string;
}) {
	return (
		<section data-doop-id={id}>
			<div className="flex items-center gap-2 border-foreground border-t-2 border-b py-1.5 text-xs">
				<span className="font-semibold">{title}</span>
				<span className="text-muted-foreground">{hint}</span>
				<span className="flex-1" />
				{action}
			</div>
			{children}
		</section>
	);
}

function MemberInput({ onAdd }: { onAdd: (account: string) => void }) {
	const [value, setValue] = useState("");
	const bad = value !== "" && !ACCOUNT_ID.test(value);
	const add = () => {
		if (!value || bad) return;
		onAdd(value);
		setValue("");
	};
	return (
		<input
			aria-label="Add a member account"
			placeholder="+ account"
			value={value}
			onChange={(e) => setValue(e.target.value.trim().toLowerCase())}
			onKeyDown={(e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					add();
				}
			}}
			onBlur={add}
			className={cn(input, "h-5 w-28 text-[11px]", bad && "border-destructive")}
		/>
	);
}

function QueueRow({
	queue,
	onChange,
	onRemove,
}: {
	queue: Queue;
	onChange: (patch: Partial<Queue>) => void;
	onRemove: () => void;
}) {
	return (
		<div
			className="grid grid-cols-[120px_1fr_56px_20px] items-start gap-2 border-b py-1.5"
			data-doop-id={`queue-${queue.name}`}
		>
			<span className="pt-0.5 font-semibold">{queue.name}</span>
			<div className="flex min-w-0 flex-col gap-1">
				<input
					aria-label={`Description of ${queue.name}`}
					placeholder="What this queue is for"
					value={queue.description}
					onChange={(e) => onChange({ description: e.target.value })}
					className={cn(
						input,
						"w-full border-transparent bg-transparent px-0 text-muted-foreground hover:border-border focus:px-1.5",
					)}
				/>
				<div className="flex flex-wrap items-center gap-1">
					{queue.members.length === 0 && (
						<span className="text-[11px] text-muted-foreground">
							no members: nobody takes this work
						</span>
					)}
					{queue.members.map((m) => (
						<span key={m} className={chip}>
							{m}
							<button
								type="button"
								aria-label={`Remove ${m} from ${queue.name}`}
								className="text-muted-foreground hover:text-foreground"
								onClick={() =>
									onChange({ members: queue.members.filter((x) => x !== m) })
								}
							>
								×
							</button>
						</span>
					))}
					<MemberInput
						onAdd={(a) =>
							!queue.members.includes(a) &&
							onChange({ members: [...queue.members, a] })
						}
					/>
				</div>
			</div>
			<input
				aria-label={`Most beads of ${queue.name} one account may hold`}
				title="Most beads one account may hold at once (empty: no limit)"
				inputMode="numeric"
				placeholder="—"
				value={queue.maxPerAccount ?? ""}
				onChange={(e) => {
					const n = Number.parseInt(e.target.value, 10);
					onChange({ maxPerAccount: n >= 1 ? n : undefined });
				}}
				className={cn(input, "w-14 text-right tabular-nums")}
			/>
			<button
				type="button"
				aria-label={`Remove queue ${queue.name}`}
				title="Remove the queue and its rules"
				onClick={onRemove}
				className="mt-0.5 size-5 rounded-[var(--radius)] border text-[11px] text-muted-foreground hover:text-foreground"
			>
				×
			</button>
		</div>
	);
}

function RuleRow({
	index,
	rule,
	queues,
	last,
	winning,
	onChange,
	onMove,
	onRemove,
}: {
	index: number;
	rule: Rule;
	queues: Queue[];
	last: boolean;
	winning: boolean;
	onChange: (rule: Rule) => void;
	onMove: (delta: number) => void;
	onRemove: () => void;
}) {
	const m = rule.match;
	const set = (patch: Partial<Rule["match"]>) => {
		const match = { ...m, ...patch };
		for (const k of Object.keys(match) as (keyof typeof match)[])
			if (
				match[k] === undefined ||
				match[k] === "" ||
				(Array.isArray(match[k]) && (match[k] as string[]).length === 0)
			)
				delete match[k];
		onChange({ ...rule, match });
	};
	const icon =
		"size-5 rounded-[var(--radius)] border bg-card text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40";
	return (
		<div
			className={cn(
				"grid grid-cols-[20px_1fr_14px_104px_68px] items-center gap-2 border-b py-1.5",
				winning && "bg-muted",
			)}
			data-doop-id={`rule-${index + 1}`}
		>
			<span className="font-semibold text-[11px] text-muted-foreground tabular-nums">
				{index + 1}
			</span>
			<div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
				<LabelsInput
					value={m.labels ?? []}
					onChange={(labels) => set({ labels })}
				/>
				<input
					aria-label="Type"
					placeholder="type"
					value={m.type ?? ""}
					onChange={(e) => set({ type: e.target.value.trim() || undefined })}
					className={cn(input, "h-5 w-16 text-[11px]")}
				/>
				<select
					aria-label="Priority"
					value={m.maxPriority ?? ""}
					onChange={(e) =>
						set({
							maxPriority:
								e.target.value === ""
									? undefined
									: (Number(e.target.value) as 0 | 1 | 2 | 3 | 4),
						})
					}
					className={cn(input, "h-5 w-[92px] px-0.5 text-[11px]")}
				>
					<option value="">any P</option>
					{[0, 1, 2, 3, 4].map((p) => (
						<option key={p} value={p}>
							{p === 0 ? "P0" : `P0–P${p}`}
						</option>
					))}
				</select>
				<input
					aria-label="Id starts with"
					placeholder="id prefix"
					value={m.idPrefix ?? ""}
					onChange={(e) =>
						set({ idPrefix: e.target.value.trim() || undefined })
					}
					className={cn(input, "h-5 w-16 text-[11px]")}
				/>
			</div>
			<span className="text-muted-foreground">→</span>
			<select
				aria-label={`Queue of rule ${index + 1}`}
				value={rule.queue}
				onChange={(e) => onChange({ ...rule, queue: e.target.value })}
				className={cn(
					input,
					"h-5 px-0.5 font-medium text-[11px]",
					!queues.some((q) => q.name === rule.queue) && "border-destructive",
				)}
			>
				{!queues.some((q) => q.name === rule.queue) && (
					<option value={rule.queue}>{rule.queue || "pick a queue"}</option>
				)}
				{queues.map((q) => (
					<option key={q.name} value={q.name}>
						{q.name}
					</option>
				))}
			</select>
			<span className="flex justify-end gap-1">
				<button
					type="button"
					className={icon}
					aria-label="Move up"
					disabled={index === 0}
					onClick={() => onMove(-1)}
				>
					↑
				</button>
				<button
					type="button"
					className={icon}
					aria-label="Move down"
					disabled={last}
					onClick={() => onMove(1)}
				>
					↓
				</button>
				<button
					type="button"
					className={icon}
					aria-label="Remove rule"
					onClick={onRemove}
				>
					×
				</button>
			</span>
		</div>
	);
}

/** Labels as text; parsed when the field loses focus or Enter is pressed. */
function LabelsInput({
	value,
	onChange,
}: {
	value: string[];
	onChange: (labels: string[]) => void;
}) {
	const [text, setText] = useState(value.join(" "));
	useEffect(() => setText(value.join(" ")), [value]);
	const commit = () => onChange(parseLabels(text));
	return (
		<input
			aria-label="Labels (all must be on the bead)"
			placeholder="labels"
			value={text}
			onChange={(e) => setText(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => e.key === "Enter" && commit()}
			className={cn(input, "h-5 w-28 text-[11px]")}
		/>
	);
}

function AddQueue({ onAdd }: { onAdd: (name: string) => void }) {
	const [name, setName] = useState("");
	const [open, setOpen] = useState(false);
	const bad = name !== "" && !QUEUE_NAME.test(name);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!name || bad) return;
		onAdd(name);
		setName("");
		setOpen(false);
	};
	if (!open)
		return (
			<Button
				size="sm"
				variant="outline"
				className="h-5 px-1.5 text-[11px]"
				onClick={() => setOpen(true)}
			>
				Add queue
			</Button>
		);
	return (
		<form onSubmit={submit} className="flex items-center gap-1">
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by a click on "Add queue"
				autoFocus
				aria-label="New queue name"
				placeholder="name (a-z 0-9 _ -)"
				value={name}
				onChange={(e) => setName(e.target.value.trim())}
				onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
				className={cn(
					input,
					"h-5 w-36 text-[11px]",
					bad && "border-destructive",
				)}
			/>
			<Button
				type="submit"
				size="sm"
				className="h-5 px-1.5 text-[11px]"
				disabled={!name || bad}
			>
				Add
			</Button>
		</form>
	);
}

function TryBead({
	draft,
	onResult,
}: {
	draft: RoutingDoc;
	onResult: (e: Explanation | null) => void;
}) {
	const [text, setText] = useState("");
	const [result, setResult] = useState<{
		label: string;
		e: Explanation;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const submit = (ev: FormEvent) => {
		ev.preventDefault();
		const parsed = parseTry(text);
		if (!parsed) return;
		setError(null);
		tryRouting(parsed, draft)
			.then((e) => {
				setResult({ label: text.trim(), e });
				onResult(e);
			})
			.catch((err) => {
				setResult(null);
				onResult(null);
				setError(errorText(err));
			});
	};
	return (
		<Section
			id="routing-try"
			title="Try a bead"
			hint="uses the rules on screen, saved or not"
		>
			<form onSubmit={submit} className="flex items-center gap-2 py-2">
				<input
					aria-label="A bead id, or a sketch: type, P0-P4, labels"
					placeholder="mm-214  or  bug P0 area:api"
					value={text}
					onChange={(e) => setText(e.target.value)}
					className={cn(input, "w-72")}
				/>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
				>
					Try
				</Button>
			</form>
			{error && <p className="text-destructive text-xs">{error}</p>}
			{result && (
				<div className="flex items-baseline gap-2 border-b py-1.5">
					<span className="text-[11px] text-muted-foreground">
						{result.label}
					</span>
					<span className="font-semibold text-sm">
						{result.e.queue ? `→ ${result.e.queue}` : "unrouted"}
					</span>
					<span className="text-muted-foreground text-xs">{result.e.why}</span>
				</div>
			)}
		</Section>
	);
}

export function RoutingPage() {
	const [saved, setSaved] = useState<Routing | null>(null);
	const [draft, setDraft] = useState<RoutingDoc | null>(null);
	const [conflict, setConflict] = useState<Routing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [winner, setWinner] = useState<number | null>(null);

	const load = useCallback(() => {
		setError(null);
		getRouting()
			.then((r) => {
				setSaved(r);
				setDraft({ queues: r.queues, rules: r.rules });
				setConflict(null);
			})
			.catch((e) => setError(errorText(e)));
	}, []);
	useEffect(load, [load]);

	if (!draft || !saved)
		return (
			<div className="px-4 py-4 text-muted-foreground text-sm">
				{error ?? "Loading routing…"}
			</div>
		);

	const edit = (next: RoutingDoc) => {
		setDraft(next);
		setWinner(null);
	};
	const dirty = changes(saved, draft);
	const save = () => {
		setSaving(true);
		setError(null);
		saveRouting(draft, saved.revision)
			.then((r) => {
				setSaved(r);
				setDraft({ queues: r.queues, rules: r.rules });
				setConflict(null);
			})
			.catch((e) => {
				if (e instanceof ApiError && e.status === 409)
					setConflict(e.body.current as Routing);
				else setError(errorText(e));
			})
			.finally(() => setSaving(false));
	};
	const reload = () => {
		if (!conflict) return load();
		setSaved(conflict);
		setDraft({ queues: conflict.queues, rules: conflict.rules });
		setConflict(null);
	};

	return (
		<div className="h-full overflow-auto pb-8">
			<div
				className="flex flex-wrap items-baseline gap-4 px-4 pt-4 pb-3"
				data-doop-id="routing-head"
			>
				<h1 className="font-bold text-xl tracking-tight">Routing</h1>
				<span className="text-muted-foreground text-xs tabular-nums">
					{draft.queues.length} queues · {draft.rules.length} rules · revision{" "}
					{saved.revision}
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
					onClick={() => edit({ queues: saved.queues, rules: saved.rules })}
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
					data-doop-id="routing-conflict"
					className="mx-4 mb-3 flex items-center gap-3 border border-destructive border-l-[3px] px-2.5 py-1.5 text-xs"
				>
					<b className="font-semibold text-destructive">Not saved.</b>
					<span>
						Somebody else saved routing first (revision {conflict.revision}).
						Reload to see their change, then apply yours again.
					</span>
					<span className="flex-1" />
					<Button
						size="sm"
						variant="outline"
						className="h-5 px-1.5 text-[11px]"
						onClick={reload}
					>
						Reload
					</Button>
				</div>
			)}
			{error && (
				<p
					role="alert"
					className="mx-4 mb-3 border border-destructive px-2.5 py-1.5 text-xs"
				>
					{error}
				</p>
			)}

			<div className="grid gap-6 px-4 lg:grid-cols-2">
				<Section
					id="routing-queues"
					title="Queues"
					hint="who may take work from each queue"
					action={<AddQueue onAdd={(name) => edit(addQueue(draft, name))} />}
				>
					<div className="grid grid-cols-[120px_1fr_56px_20px] gap-2 border-b py-1 text-[11px] text-muted-foreground">
						<span>Name</span>
						<span>Description and members</span>
						<span className="text-right">Max each</span>
						<span />
					</div>
					{draft.queues.length === 0 && (
						<p className="py-2 text-muted-foreground text-xs">
							No queues yet. While nobody has saved routing, every account may
							take work from every queue. After the first save, only members
							may.
						</p>
					)}
					{draft.queues.map((q) => (
						<QueueRow
							key={q.name}
							queue={q}
							onChange={(patch) => edit(setQueue(draft, q.name, patch))}
							onRemove={() => edit(removeQueue(draft, q.name))}
						/>
					))}
				</Section>

				<div className="flex flex-col gap-4">
					<Section
						id="routing-rules"
						title="Rules"
						hint="first match wins · a queue label on a bead wins over all rules"
						action={
							<Button
								size="sm"
								variant="outline"
								className="h-5 px-1.5 text-[11px]"
								disabled={draft.queues.length === 0}
								onClick={() => edit(addRule(draft))}
							>
								Add rule
							</Button>
						}
					>
						{draft.rules.length === 0 && (
							<p className="py-2 text-muted-foreground text-xs">
								No rules: new beads stay unrouted.
							</p>
						)}
						{draft.rules.map((r, i) => (
							<RuleRow
								// biome-ignore lint/suspicious/noArrayIndexKey: rules have no id; their position is their identity
								key={i}
								index={i}
								rule={r}
								queues={draft.queues}
								last={i === draft.rules.length - 1}
								winning={winner === i}
								onChange={(rule) => edit(setRule(draft, i, rule))}
								onMove={(d) => edit(moveRule(draft, i, d))}
								onRemove={() => edit(removeRule(draft, i))}
							/>
						))}
					</Section>
					<TryBead
						draft={draft}
						onResult={(e) => setWinner(e?.ruleIndex ?? null)}
					/>
				</div>
			</div>
		</div>
	);
}
