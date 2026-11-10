import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type LoginResult, login, tokenFromHash } from "./login.ts";

export function LoginPage() {
	const navigate = useNavigate();
	const [result, setResult] = useState<LoginResult | null>(null);
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
			if (r.kind === "ok") void navigate({ to: "/board" });
		});
	}, [navigate]);

	return (
		<div className="mx-auto max-w-sm px-4 py-10">
			<h1 className="font-bold text-lg">Log in</h1>
			<p className="mt-2 text-muted-foreground text-sm" role="status">
				{message(result)}
			</p>
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
