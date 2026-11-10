/**
 * `bun deploy/dokploy.ts first-login`: find the newest first-login line in
 * the app log. While no account exists, every start of the app logs
 *
 *   auth: first login (single use): <public url>/login#mml_...
 *
 * and the URL of the previous start stops working, so only the newest line
 * counts. With an account, the app logs `auth: first login: not needed ...`.
 */

export const FIRST_LOGIN = "auth: first login";

export type FirstLogin =
	| { kind: "url"; url: string; at: string | null }
	| { kind: "not-needed"; at: string | null }
	| { kind: "none" };

/**
 * The newest first-login line of `log` (Docker log text, with or without
 * `--timestamps`, in time order). Lines of `docker service logs` from many
 * tasks are sorted by their timestamp first.
 */
export function newestFirstLogin(log: string): FirstLogin {
	const lines = log
		.split(/\r?\n/)
		.map(parseLine)
		.filter((l): l is Line => l !== null)
		.map((l, i) => ({ ...l, i }))
		.sort((a, b) =>
			a.at && b.at && a.at !== b.at ? a.at.localeCompare(b.at) : a.i - b.i,
		);
	const last = lines.at(-1);
	if (!last) return { kind: "none" };
	const url = /(https?:\/\/\S+\/login#mml_[\w-]+)/.exec(last.text)?.[1];
	if (url) return { kind: "url", url, at: last.at };
	return { kind: "not-needed", at: last.at };
}

type Line = { at: string | null; text: string };

// `docker logs --timestamps` puts an RFC 3339 time first; `docker service
// logs` may put `<task>@<node> | ` before it.
const TIME = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/;

function parseLine(raw: string): Line | null {
	const idx = raw.indexOf(FIRST_LOGIN);
	if (idx < 0) return null;
	const at = TIME.exec(raw.slice(0, idx))?.[1] ?? null;
	return { at, text: raw.slice(idx) };
}
