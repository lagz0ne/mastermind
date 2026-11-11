import type { PeopleSetup } from "@mastermind/core";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadMe, loadSetup } from "../session/session.ts";
import {
	type CodeStart,
	clock,
	LOGIN_CHANNEL,
	pollCode,
	resumeOrStart,
	secondsLeft,
	startCode,
	usedOrExpired,
} from "./login.ts";

type Phase =
	| { kind: "starting" }
	| CodeStart
	| { kind: "expired" }
	| { kind: "ok"; account: string }
	| { kind: "skip" };

const POLL_MS = 1500;

export function LoginPage() {
	const [phase, setPhase] = useState<Phase>({ kind: "starting" });
	const [setup, setSetup] = useState<PeopleSetup | null>(null);
	const started = useRef(false);

	// A full navigation: the board loads the new session from the server,
	// so no stale "anon" state sends the user back here.
	// Other /login tabs of this browser follow (they share the cookie).
	const done = useCallback((account: string) => {
		setPhase({ kind: "ok", account });
		if (typeof BroadcastChannel !== "undefined") {
			const ch = new BroadcastChannel(LOGIN_CHANNEL);
			ch.postMessage({ account });
			ch.close();
		}
		window.location.assign("/board");
	}, []);

	useEffect(() => {
		if (typeof BroadcastChannel === "undefined") return;
		const ch = new BroadcastChannel(LOGIN_CHANNEL);
		ch.onmessage = (e: MessageEvent<{ account?: unknown }>) => {
			if (typeof e.data?.account !== "string") return;
			setPhase({ kind: "ok", account: e.data.account });
			window.location.assign("/board");
		};
		return () => ch.close();
	}, []);

	const newCode = useCallback(async () => {
		setPhase({ kind: "starting" });
		setPhase(await startCode());
	}, []);

	useEffect(() => {
		// Strict mode runs effects twice; one code per page load.
		if (started.current) return;
		started.current = true;
		void loadSetup().then(async (s) => {
			setSetup(s);
			if (s?.auth === "off" || s?.auth === "unconfigured")
				return setPhase({ kind: "skip" });
			// Another tab may have logged this browser in already.
			const me = await loadMe();
			if (me.kind === "ok") return done(me.me.account);
			// A reload keeps the pending code of this browser.
			const r = await resumeOrStart();
			if (r.kind === "ok") done(r.account);
			else setPhase(r);
		});
	}, [done]);

	// Poll while a code is shown: on an interval, and at once when the tab
	// comes back (a sleeping or background tab throttles its timers).
	const showing = phase.kind === "code";
	useEffect(() => {
		if (!showing) return;
		let stop = false;
		let busy = false;
		const check = async () => {
			// One poll at a time: an approved poll uses up the pending login.
			if (stop || busy) return;
			busy = true;
			const r = await pollCode().finally(() => {
				busy = false;
			});
			if (stop) return;
			if (r.kind === "ok") {
				stop = true;
				done(r.account);
			} else if (r.kind === "expired") {
				const after = await usedOrExpired();
				if (stop) return;
				if (after.kind === "ok") {
					stop = true;
					done(after.account);
				} else setPhase(after);
			}
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") void check();
		};
		const timer = setInterval(check, POLL_MS);
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", check);
		return () => {
			stop = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", check);
		};
	}, [showing, done]);

	return (
		<div className="mx-auto max-w-sm px-4 py-10">
			<h1 className="font-bold text-lg">Log in</h1>
			<CodePanel phase={phase} onNewCode={newCode} />
			{phase.kind === "ok" ? null : <SetupHint setup={setup} />}
			{phase.kind === "skip" ? (
				<p className="mt-4 text-sm">
					<Link to="/board" className="underline">
						Go to the board
					</Link>
				</p>
			) : null}
		</div>
	);
}

function CodePanel({
	phase,
	onNewCode,
}: {
	phase: Phase;
	onNewCode: () => void;
}) {
	switch (phase.kind) {
		case "skip":
			return null;
		case "starting":
			return (
				<p className="mt-2 text-muted-foreground text-sm" role="status">
					Getting a login code…
				</p>
			);
		case "ok":
			return (
				<p className="mt-2 text-sm" role="status">
					Logged in as {phase.account}.
				</p>
			);
		case "error":
			return (
				<div className="mt-2 text-sm" role="status">
					<p>Could not get a login code: {phase.message}</p>
					<NewCode onClick={onNewCode} />
				</div>
			);
		case "expired":
			return (
				<div className="mt-2 text-sm" role="status">
					<p>This code expired or was used. Get a new one.</p>
					<NewCode onClick={onNewCode} />
				</div>
			);
		case "code":
			return (
				<ShowCode
					code={phase.code}
					expiresAt={phase.expiresAt}
					onNewCode={onNewCode}
				/>
			);
	}
}

function ShowCode({
	code,
	expiresAt,
	onNewCode,
}: {
	code: string;
	expiresAt: string;
	onNewCode: () => void;
}) {
	const [left, setLeft] = useState(() => secondsLeft(expiresAt));
	useEffect(() => {
		const t = setInterval(() => setLeft(secondsLeft(expiresAt)), 1000);
		return () => clearInterval(t);
	}, [expiresAt]);
	return (
		<div className="mt-2 text-sm">
			<p>Tell this code to the operator, or to a person who has an account.</p>
			<span className="sr-only">Login code:</span>
			<p className="my-4 border-foreground border-y-2 py-3 text-center font-bold font-mono text-4xl tracking-widest">
				{code}
			</p>
			<p className="text-muted-foreground" role="status">
				Keep this page open. It logs in by itself when the code is approved.{" "}
				{left > 0 ? `The code expires in ${clock(left)}.` : "The code expired."}
			</p>
			<NewCode onClick={onNewCode} />
		</div>
	);
}

function NewCode({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			className="mt-3 border border-foreground px-2 py-1 text-sm hover:bg-foreground hover:text-background"
			onClick={onClick}
		>
			New code
		</button>
	);
}

/** Auth off or not configured, or no account yet. */
function SetupHint({ setup }: { setup: PeopleSetup | null }) {
	if (!setup) return null;
	if (setup.auth === "off")
		return (
			<p className="mt-4 text-sm">
				Auth is off on this server (AUTH_DISABLED=1, local development). No
				login is needed.
			</p>
		);
	if (setup.auth === "unconfigured")
		return (
			<p className="mt-4 text-sm">
				Auth is not configured on this server. Set NATS_WS_URL, NATS_ISSUER_SEED
				and NATS_AUTH_PASSWORD.
			</p>
		);
	if (setup.firstLogin)
		return (
			<div className="mt-4 border-foreground border-t-2 pt-2 text-sm">
				<p className="font-semibold">No account exists yet.</p>
				<p className="mt-1">
					The operator approves the first login:{" "}
					<code>
						bun deploy/dokploy.ts login-approve &lt;code&gt; --account
						&lt;name&gt;
					</code>
					. That makes the account.
				</p>
			</div>
		);
	return null;
}
