// Incident mm-210.38: a NATS connection of the api ended in the closed state,
// the process stayed alive and logged an error every second for 11.5 h. A
// closed connection never comes back, so the api exits non-zero and the
// orchestrator starts a new process.

/** Exit code when a NATS connection closes on its own. */
export const NATS_CLOSED_EXIT = 1;

export type NatsClosed = (name: string, error?: Error) => void;

/**
 * Returns the handler for "a connection closed that nobody closed": it logs
 * ONE line and exits. Later calls do nothing (no log loop while exiting).
 */
export function exitOnNatsClosed(
	opts: { exit?: (code: number) => void; log?: (line: string) => void } = {},
): NatsClosed {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const log = opts.log ?? console.error;
	let fired = false;
	return (name, error) => {
		if (fired) return;
		fired = true;
		log(
			`nats: connection ${name} closed (${error ?? "no error"}); exiting with ${NATS_CLOSED_EXIT} so the orchestrator starts a new process`,
		);
		exit(NATS_CLOSED_EXIT);
	};
}
