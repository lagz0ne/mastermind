/**
 * Wire format of every Mastermind request/reply: JSON in, and one of two
 * JSON envelopes back:
 *
 *   { "result": <TRes> }                          success
 *   { "error": { "code": "...", "message": "..." } }   failure
 *
 * Adapters in any language can read this without a NATS services framework.
 */

export const ERROR_CODES = [
	/** The request body is not valid JSON or not the right shape. */
	"bad_request",
	/** The caller may not do this. */
	"forbidden",
	"not_found",
	/** Lost a race: stale revision, already claimed, already exists. */
	"conflict",
	/** Nobody serves the subject. */
	"unavailable",
	"timeout",
	"internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorBody = { code: ErrorCode; message: string };
export type Reply<T> = { result: T } | { error: ErrorBody };

/** The error type that crosses the bus: thrown by handlers, raised by `request`. */
export class BusError extends Error {
	override name = "BusError";
	constructor(
		readonly code: ErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
	toBody(): ErrorBody {
		return { code: this.code, message: this.message };
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encode(value: unknown): Uint8Array {
	return enc.encode(JSON.stringify(value));
}

/** Parse JSON; an empty payload is `undefined`. Throws BusError("bad_request"). */
export function decode<T>(data: Uint8Array): T {
	if (data.length === 0) return undefined as T;
	try {
		return JSON.parse(dec.decode(data)) as T;
	} catch (err) {
		throw new BusError("bad_request", "payload is not JSON", { cause: err });
	}
}

const isCode = (c: unknown): c is ErrorCode =>
	(ERROR_CODES as readonly unknown[]).includes(c);

/** Turn a reply envelope into its result, or throw the BusError it carries. */
export function unwrap<T>(reply: unknown): T {
	if (reply !== null && typeof reply === "object") {
		if ("result" in reply) return reply.result as T;
		if ("error" in reply) {
			const e = reply.error as Partial<ErrorBody> | null;
			const code = isCode(e?.code) ? e.code : "internal";
			throw new BusError(
				code,
				typeof e?.message === "string" ? e.message : "unknown error",
			);
		}
	}
	throw new BusError("internal", "reply is not a Mastermind envelope");
}

/** The envelope for a handler failure. Unknown errors do not leak their message. */
export function errorReply(err: unknown): { error: ErrorBody } {
	if (err instanceof BusError) return { error: err.toBody() };
	return { error: { code: "internal", message: "internal error" } };
}
