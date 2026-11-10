import type { PeopleSetup } from "@mastermind/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { loadSetup, setMe } from "../session/session.ts";
import { type LoginResult, login, tokenFromHash } from "./login.ts";

export function LoginPage() {
	const navigate = useNavigate();
	const [result, setResult] = useState<LoginResult | null>(null);
	const [setup, setSetup] = useState<PeopleSetup | null>(null);
	const started = useRef(false);

	useEffect(() => {
		// Strict mode runs effects twice; the token is single use.
		if (started.current) return;
		started.current = true;
		const token = tokenFromHash(window.location.hash);
		// Take the token out of the address bar and the history.
		if (token) window.history.replaceState(null, "", window.location.pathname);
		login(token).then((r) => {
			setResult(r);
			if (r.kind === "ok") {
				setMe({ account: r.account, auth: "on" });
				void navigate({ to: "/board" });
			}
		});
		void loadSetup().then(setSetup);
	}, [navigate]);

	return (
		<div className="mx-auto max-w-sm px-4 py-10">
			<h1 className="font-bold text-lg">Log in</h1>
			<p className="mt-2 text-muted-foreground text-sm" role="status">
				{message(result)}
			</p>
			{result?.kind === "ok" ? null : <SetupHint setup={setup} />}
			{result?.kind === "ok" ? null : (
				<p className="mt-4 text-sm">
					<Link to="/board" className="underline">
						Go to the board
					</Link>
				</p>
			)}
		</div>
	);
}

function message(r: LoginResult | null): string {
	switch (r?.kind) {
		case undefined:
			return "Logging in…";
		case "no-token":
			return "Open the login link that you received. Each link works once.";
		case "ok":
			return `Logged in as ${r.account}.`;
		case "refused":
			return "This login link is used or expired. Ask for a new one.";
		case "error":
			return `Login failed: ${r.message}`;
	}
}

/** Why there may be no link yet: first start, auth off, or not configured. */
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
					At first start, the server writes one login link for the first account
					(<code>admin</code>) to its log. Find the line that starts with{" "}
					<code>auth: first login</code> and open that link. It works once and
					expires in 24 h; a restart after that writes a new one.
				</p>
			</div>
		);
	return null;
}
