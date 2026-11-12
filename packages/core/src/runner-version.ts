/**
 * The one wording for a runner that is not at the server's version (mm-210.77).
 * The runner (terminal, status, doctor), /people and the operator's debug state
 * all use it.
 */

/** A commit as people read it: the first 7 characters. */
export function shortVersion(v: string): string {
	return /^[0-9a-f]{8,}$/i.test(v) ? v.slice(0, 7) : v;
}

/**
 * The notice for a runner at `runner` while the server is at `server`; null
 * when they are the same, either one is unknown, or either one runs from
 * source ("dev").
 */
export function runnerVersionNotice(
	runner: string | null | undefined,
	server: string | null | undefined,
): string | null {
	if (!runner || !server || runner === "dev" || server === "dev") return null;
	if (runner === server) return null;
	return `runner ${shortVersion(runner)} is older than the server ${shortVersion(server)}: run mastermind-runner update`;
}
