// Lease renewal. bd serve (bd 1.3.4) has no heartbeat route, and a second
// :claim by the holder answers already_claimed without moving the lease. The
// CLI `bd heartbeat <id>` does renew it, so the dispatcher runs it as the
// holder, in bd serve's workspace (same Dolt server and database).
import { BdError } from "@mastermind/beads";

/** How to run the bd CLI against the same database as bd serve. */
export type BdCli = {
	bin: string;
	/** Workspace root (bd serve's cwd). */
	cwd: string;
	/** bd serve's env (BEADS_DIR, Dolt host, port, user, password). */
	env: Record<string, string>;
	/** Default 15 s. */
	timeoutMs?: number;
};

/** Pushes the lease of `id` forward. Throws BdError(409) when `actor` does not hold it. */
export type Heartbeat = (id: string, actor: string) => Promise<void>;

export function bdHeartbeat(cli: BdCli): Heartbeat {
	return async (id, actor) => {
		const proc = Bun.spawn([cli.bin, "heartbeat", "--json", "--", id], {
			cwd: cli.cwd,
			// The actor goes in env, not argv: bd takes the holder from BEADS_ACTOR.
			env: { ...process.env, ...cli.env, BEADS_ACTOR: actor },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: cli.timeoutMs ?? 15_000,
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code === 0) return;
		const refusal = errorOf(out) ?? errorOf(err);
		if (refusal) throw new BdError(409, "heartbeat_refused", refusal);
		throw new Error(
			`bd heartbeat ${id} exited with ${code ?? proc.signalCode}: ${err.trim().slice(-500)}`,
		);
	};
}

/** bd --json prints `{"error": "..."}` when it refuses (not the holder, closed). */
function errorOf(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	try {
		const body: unknown = JSON.parse(text.slice(start));
		const error = (body as { error?: unknown }).error;
		return typeof error === "string" ? error : null;
	} catch {
		return null;
	}
}
