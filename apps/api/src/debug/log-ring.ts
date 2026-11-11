/**
 * The last error lines of the process, for GET /api/debug/state. Every
 * console.error feeds it (see {@link captureConsoleErrors}); secrets are
 * stripped before a line is kept.
 */

/** Credentials, enrol and login tokens: `mms_...`, `mme_...`, `mml_...`. */
const TOKEN = /\b(mm[lems])_[A-Za-z0-9_-]+/g;
/** Login codes as shown: `ABCD-EFGH`. */
const CODE = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g;
/** `Bearer <anything>`. */
const BEARER = /\b(Bearer)\s+\S+/gi;

export function redact(line: string): string {
	return line
		.replace(TOKEN, "$1_[redacted]")
		.replace(CODE, "[code]")
		.replace(BEARER, "$1 [redacted]");
}

export type LogLine = { at: string; line: string };

export class LogRing {
	readonly #lines: LogLine[] = [];
	readonly #listeners = new Set<(line: LogLine) => void>();
	constructor(
		readonly size = 100,
		private readonly now: () => Date = () => new Date(),
	) {}

	push(line: string): void {
		const entry = {
			at: this.now().toISOString(),
			line: redact(line).slice(0, 2_000),
		};
		this.#lines.push(entry);
		if (this.#lines.length > this.size) this.#lines.shift();
		for (const l of this.#listeners) {
			try {
				l(entry);
			} catch {
				// A listener must not break logging.
			}
		}
	}

	/** Every new line, redacted. */
	subscribe(listener: (line: LogLine) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Oldest first. */
	lines(): LogLine[] {
		return [...this.#lines];
	}
}

function text(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

/** Copy every console.error line into `ring`; the console still prints it. */
export function captureConsoleErrors(ring: LogRing): void {
	const original = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		ring.push(args.map(text).join(" "));
		original(...args);
	};
}
