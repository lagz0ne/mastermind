import type { RunnerView } from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMe } from "../session/session.ts";
import {
	type AccountGroup,
	ago,
	approveLogin,
	enrolToken,
	groupByAccount,
	type LoginApproval,
	outdated,
	type People,
	RUNNER_BIN,
	revoke,
	runnerCommand,
	statsOf,
	usePeople,
} from "./people.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_HINT = "a-z, 0-9 and -, at most 32";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A one-time secret (a command) with a copy button. */
function Secret({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-xs">{label}</span>
			<div className="flex items-start gap-2">
				<code className="min-w-0 flex-1 select-all break-all border bg-muted px-2 py-1 font-mono text-[12px] leading-4">
					{value}
				</code>
				<Button
					size="sm"
					variant="outline"
					onClick={() =>
						navigator.clipboard
							.writeText(value)
							.then(() => setCopied(true))
							.catch(() => {})
					}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<span className="text-muted-foreground text-xs">
				Shown once. It works once and expires in 24 h.
			</span>
		</div>
	);
}

/**
 * Approve a login: the person opens /login and reads out the code. My own
 * account name logs in another device of mine; a new name makes that account.
 */
function ApproveLoginPanel({
	me,
	onDone,
}: {
	me: string | null;
	onDone: () => void;
}) {
	const [code, setCode] = useState("");
	const [account, setAccount] = useState("");
	const [result, setResult] = useState<LoginApproval | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!code.trim()) return setError("the code is required");
		// Any case: the server lowers it for the id and keeps it as the display name.
		if (!ID.test(account.trim().toLowerCase()))
			return setError(`account id: ${ID_HINT}`);
		setBusy(true);
		setError(null);
		approveLogin(code, account.trim())
			.then((r) => {
				setResult(r);
				onDone();
			})
			.catch((err) => setError(errorText(err)))
			.finally(() => setBusy(false));
	};
	if (result)
		return (
			<div className="flex flex-col gap-1 text-sm" role="status">
				<span>
					Approved for <b>{result.account}</b>
					{result.created ? " (new account)" : ""}. That browser logs in within
					a few seconds.
				</span>
				<span className="text-muted-foreground text-xs">
					The code was made {result.ageSeconds}s ago by:{" "}
					{result.userAgent || "(no user agent)"}
				</span>
			</div>
		);
	return (
		<form onSubmit={submit} className="flex flex-col gap-2">
			<span className="text-muted-foreground text-xs">
				The person opens /login and reads you the code. Your own id
				{me ? ` (${me})` : ""} logs in another device of yours; a new id makes
				that account.
			</span>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor="approve-code" className="text-sm">
					Code
				</label>
				<input
					id="approve-code"
					value={code}
					onChange={(e) => setCode(e.target.value.toUpperCase())}
					placeholder="ABCD-EFGH"
					autoComplete="off"
					className="h-7 w-32 border bg-background px-2 font-mono text-sm uppercase"
				/>
				<label htmlFor="approve-account" className="text-sm">
					Account name
				</label>
				<input
					id="approve-account"
					value={account}
					onChange={(e) => setAccount(e.target.value)}
					title="Any case: the id is the name in lowercase; the name keeps your case"
					placeholder="minh"
					autoComplete="off"
					className="h-7 w-40 border bg-background px-2 font-mono text-sm"
				/>
				<Button size="sm" type="submit" disabled={busy}>
					Approve
				</Button>
				{error && <span className="text-signal text-xs">{error}</span>}
			</div>
		</form>
	);
}

function AddRunnerPanel({ onDone }: { onDone: () => void }) {
	const [name, setName] = useState("");
	const [queue, setQueue] = useState("");
	const [command, setCommand] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!ID.test(name)) return setError(`runner name: ${ID_HINT}`);
		if (!queue) return setError("queue is required");
		setBusy(true);
		setError(null);
		enrolToken(name)
			.then((token) => {
				setCommand(runnerCommand(window.location.origin, token, queue));
				onDone();
			})
			.catch((err) => setError(errorText(err)))
			.finally(() => setBusy(false));
	};
	if (command)
		return (
			<div className="flex flex-col gap-2" data-doop-id="runner-command">
				<Secret
					label="Run this in the work directory on the machine of the runner (Linux or macOS). It installs the runner, checks the machine, enrols it, asks for missing secrets, runs a deep doctor, and starts it when it is ready. It stops at the first failed check and prints the fix; run it again after the fix."
					value={command}
				/>
				<ul className="list-inside list-disc text-muted-foreground text-xs">
					<li>
						Before: a running Paseo daemon (<code>paseo daemon start</code>) and
						a provider that is logged in (for example <code>claude</code>).
					</li>
					<li>
						The runner gets no work before onboard passes. Again after a fix:{" "}
						<code>{RUNNER_BIN} onboard</code>
					</li>
					<li>
						Start again later: <code>{RUNNER_BIN} start</code>
					</li>
				</ul>
			</div>
		);
	return (
		<form onSubmit={submit} className="flex flex-wrap items-center gap-2">
			<label htmlFor="runner-name" className="text-sm">
				Name
			</label>
			<input
				id="runner-name"
				value={name}
				onChange={(e) => setName(e.target.value.trim().toLowerCase())}
				placeholder="laptop"
				autoComplete="off"
				className="h-7 w-32 border bg-background px-2 font-mono text-sm"
			/>
			<label htmlFor="runner-queue" className="text-sm">
				Queue
			</label>
			<input
				id="runner-queue"
				value={queue}
				onChange={(e) => setQueue(e.target.value.trim())}
				placeholder="build"
				autoComplete="off"
				className="h-7 w-32 border bg-background px-2 font-mono text-sm"
			/>
			<Button size="sm" type="submit" disabled={busy}>
				Create command
			</Button>
			{error && <span className="text-signal text-xs">{error}</span>}
		</form>
	);
}

function Capacity({ r }: { r: RunnerView }) {
	if (r.capacity === "unlimited") {
		return (
			<span className="text-[11px] text-muted-foreground">
				{r.running.length
					? `${r.running.length} / unlimited`
					: "idle · unlimited"}
			</span>
		);
	}
	if (r.capacity === null) {
		return r.running.length ? (
			<span className="text-xs">{r.running.length} busy</span>
		) : null;
	}
	const busy = Math.min(r.running.length, r.capacity);
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="inline-flex gap-0.5" aria-hidden>
				{Array.from({ length: Math.min(r.capacity, 12) }, (_, i) => (
					<i
						// biome-ignore lint/suspicious/noArrayIndexKey: slots have no identity
						key={i}
						className={cn(
							"size-2.5 border border-foreground",
							i < busy && "bg-foreground",
						)}
					/>
				))}
			</span>
			<span className="text-[11px] text-muted-foreground">
				{r.running.length ? `${r.running.length} / ${r.capacity}` : "idle"}
			</span>
		</span>
	);
}

const CELL = "flex min-h-8 items-center gap-1.5 border-b px-2 py-1.5";

function RunnerRow({
	r,
	now,
	mine,
	serverVersion,
	onRevoked,
}: {
	r: RunnerView;
	now: number;
	serverVersion?: string;
	mine: boolean;
	onRevoked: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sa = r.serviceAccount;
	const off = !r.online;
	const doRevoke = () => {
		if (!sa) return;
		if (!window.confirm(`Revoke ${sa.name}? Its runner disconnects at once.`))
			return;
		setBusy(true);
		revoke(sa.id)
			.then(onRevoked)
			.catch((err) => setError(errorText(err)))
			.finally(() => setBusy(false));
	};
	return (
		<div className="contents" data-doop-id="runner-row">
			<span className={cn(CELL, "pl-5 font-medium")}>
				<i
					aria-hidden
					className={cn(
						"size-2 shrink-0",
						off ? "border-[1.5px] border-signal" : "bg-live",
					)}
				/>
				{r.runner ?? (
					<span className="text-muted-foreground">not connected</span>
				)}
				{sa && sa.name !== r.runner && (
					<span className="font-normal text-[11px] text-muted-foreground">
						{sa.name}
					</span>
				)}
				{outdated(r, serverVersion) && (
					<span
						className="font-normal text-[11px] text-signal"
						title={`runner ${r.version ?? "unknown"}, server ${serverVersion}: install it again`}
					>
						old version
					</span>
				)}
			</span>
			<span className={cn(CELL, off && "text-signal")}>
				{r.runner ? (off ? "offline" : "online") : "enrolled"}
			</span>
			<span className={cn(CELL, "flex-wrap")}>
				{r.queues.map((q) => (
					<Badge key={q} variant="secondary">
						{q}
					</Badge>
				))}
				{r.capabilities.length > 0 && (
					<span className="text-[11px] text-muted-foreground">
						{r.capabilities.join(" · ")}
					</span>
				)}
			</span>
			<span className={CELL}>
				<Capacity r={r} />
			</span>
			<span className={cn(CELL, "flex-wrap")}>
				{r.running.length === 0 ? (
					<span className="text-muted-foreground">—</span>
				) : (
					r.running.map((id) => (
						<Link
							key={id}
							to="/board/$beadId"
							params={{ beadId: id }}
							className="font-mono text-[11px] underline-offset-2 hover:underline"
						>
							{id}
						</Link>
					))
				)}
			</span>
			<span className={cn(CELL, "text-[11px] text-muted-foreground")}>
				{r.runner ? ago(r.lastSeenAt, now) : "—"}
			</span>
			<span className={cn(CELL, "justify-end")}>
				{mine && sa && (
					<Button size="sm" variant="ghost" onClick={doRevoke} disabled={busy}>
						Revoke
					</Button>
				)}
				{error && <span className="text-signal text-xs">{error}</span>}
			</span>
		</div>
	);
}

function AccountRows({
	g,
	now,
	me,
	serverVersion,
	onChange,
}: {
	g: AccountGroup;
	now: number;
	me: string | null;
	serverVersion?: string;
	onChange: () => void;
}) {
	return (
		<>
			<div className="contents" data-doop-id={`account-${g.account}`}>
				<span
					className={cn(
						CELL,
						"border-foreground pt-4 font-semibold text-sm",
						g.account === me && "underline decoration-2 underline-offset-4",
					)}
				>
					{g.name}
				</span>
				<span
					className={cn(
						CELL,
						"border-foreground pt-4 text-[11px] text-muted-foreground",
					)}
				>
					account
				</span>
				<span
					className={cn(
						CELL,
						"col-span-5 border-foreground pt-4 text-muted-foreground text-xs",
					)}
				>
					{g.invitedBy ? `invited by ${g.invitedBy}` : "first account"}
					{g.createdAt && ` · ${new Date(g.createdAt).toLocaleDateString()}`}
					{g.runners.length === 0 && " · no runners"}
				</span>
			</div>
			{g.runners.map((r) => (
				<RunnerRow
					key={`${r.runner ?? ""}:${r.serviceAccount?.id ?? ""}`}
					r={r}
					now={now}
					mine={g.account === me}
					serverVersion={serverVersion}
					onRevoked={onChange}
				/>
			))}
		</>
	);
}

function notice(p: People): string | null {
	switch (p.status) {
		case "loading":
			return "Loading people…";
		case "reconnecting":
			return "Reconnecting to live updates…";
		case "offline":
			return `People offline: ${p.error ?? "api unreachable"}`;
		default:
			return null;
	}
}

export function PeoplePage() {
	const people = usePeople();
	const me = useMe();
	const [panel, setPanel] = useState<"approve" | "runner" | null>(null);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 5_000);
		return () => clearInterval(t);
	}, []);
	const groups = useMemo(
		() => groupByAccount(people.accounts, people.runners),
		[people.accounts, people.runners],
	);
	const stats = statsOf(groups);
	const authOff = me?.auth === "off";
	const line = notice(people);
	const toggle = (p: "approve" | "runner") =>
		setPanel((cur) => (cur === p ? null : p));

	return (
		<div className="flex h-full flex-col overflow-auto">
			<div
				className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-4 pt-4 pb-3"
				data-doop-id="people-head"
			>
				<h1 className="font-bold text-xl tracking-tight">People</h1>
				<div className="flex flex-wrap gap-x-6 text-muted-foreground text-xs tabular-nums">
					<span>
						<b className="mr-1 font-semibold text-foreground text-sm">
							{stats.accounts}
						</b>
						accounts
					</span>
					<span>
						<b className="mr-1 font-semibold text-foreground text-sm">
							{stats.online}
						</b>
						of {stats.runners} runners online
					</span>
					<span>
						<b className="mr-1 font-semibold text-foreground text-sm">
							{stats.busy}
						</b>
						of {stats.slots === null ? "unlimited" : stats.slots} slots busy
					</span>
				</div>
				<span className="flex-1" />
				<div className="flex gap-2">
					<Button
						size="sm"
						variant={panel === "approve" ? "default" : "outline"}
						onClick={() => toggle("approve")}
						disabled={authOff}
						title={authOff ? "Auth is off (AUTH_DISABLED=1)" : undefined}
					>
						Approve a login
					</Button>
					<Button
						size="sm"
						variant={panel === "runner" ? "default" : "outline"}
						onClick={() => toggle("runner")}
						disabled={authOff}
						title={authOff ? "Auth is off (AUTH_DISABLED=1)" : undefined}
					>
						Add runner
					</Button>
				</div>
			</div>
			{panel && (
				<div className="mx-4 mb-3 border-foreground border-t-2 pt-3">
					{panel === "approve" ? (
						<ApproveLoginPanel
							key="approve"
							me={me?.account ?? null}
							onDone={people.reload}
						/>
					) : (
						<AddRunnerPanel key="runner" onDone={people.reload} />
					)}
				</div>
			)}
			{line && (
				<p
					role="status"
					className="px-4 pb-2 font-mono text-[11px] text-muted-foreground"
				>
					{line}
				</p>
			)}
			<div className="overflow-x-auto px-4 pb-6">
				<div
					className="grid min-w-[900px] grid-cols-[minmax(200px,1.2fr)_72px_minmax(140px,1fr)_110px_minmax(140px,1fr)_96px_80px] text-[13px]"
					data-doop-id="people-table"
				>
					{[
						"Account / runner",
						"State",
						"Queues",
						"Capacity",
						"Working on",
						"Last seen",
						"",
					].map((h, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed header
							key={i}
							className="flex min-h-7 items-center border-foreground border-t-2 border-b px-2 font-semibold text-xs"
						>
							{h}
						</span>
					))}
					{groups.map((g) => (
						<AccountRows
							key={g.account}
							g={g}
							now={now}
							me={me?.account ?? null}
							serverVersion={people.serverVersion}
							onChange={people.reload}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
