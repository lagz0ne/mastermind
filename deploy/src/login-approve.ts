/**
 * `bun deploy/dokploy.ts login-approve <code> --account <name>`: the operator
 * approves a login code shown on <public url>/login.
 */

export type ApproveArgs = { code: string; account: string };

/** Parse `<code> --account <name>`; the code may be typed as two words. */
export function parseApproveArgs(argv: string[]): ApproveArgs | null {
	const rest: string[] = [];
	let account = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--account") account = argv[++i] ?? "";
		else if (a.startsWith("--account=")) account = a.slice(10);
		else rest.push(a);
	}
	const code = rest.join("").trim();
	return code && account ? { code, account } : null;
}

export type Approval = {
	account: string;
	created: boolean;
	ageSeconds: number;
	userAgent: string;
};

/** What the operator reads after an approval (so that they can spot a stranger). */
export function describeApproval(a: Approval): string {
	return [
		`login-approve: approved for account '${a.account}'${a.created ? " (new account)" : ""}.`,
		`  the code was made ${a.ageSeconds}s ago by: ${a.userAgent || "(no user agent)"}`,
		"  that browser logs in within a few seconds.",
	].join("\n");
}

/** A failed approval, by HTTP status. */
export function approveError(status: number, error: string): string {
	switch (status) {
		case 404:
			return "no such code: it is wrong, used or expired (10 min). Ask for the code on the page now, or press 'New code' there.";
		case 401:
			return "the app refused the operator key. Is MASTERMIND_OPERATOR_KEY in the app env (run apply) and is the app redeployed since?";
		case 429:
			return "too many approvals; wait a minute.";
		case 503:
			return "auth on the app is starting or not configured; try again in a minute.";
		default:
			return `HTTP ${status}: ${error}`;
	}
}
