import {
	errors,
	type Msg,
	type NatsConnection,
	type Subscription,
} from "@nats-io/nats-core";
import { BusError, decode, encode, errorReply, unwrap } from "./codec.ts";

export type RequestOptions = { timeout?: number };

/** Map a nats-core request failure to a BusError. */
export function requestFailure(err: unknown, subject: string): BusError {
	if (err instanceof BusError) return err;
	const cause =
		err instanceof errors.RequestError && err.cause ? err.cause : err;
	if (
		cause instanceof errors.NoRespondersError ||
		(err instanceof errors.RequestError && err.isNoResponders())
	) {
		return new BusError("unavailable", `no responders on ${subject}`, {
			cause: err,
		});
	}
	if (cause instanceof errors.TimeoutError) {
		return new BusError("timeout", `request timed out on ${subject}`, {
			cause: err,
		});
	}
	if (cause instanceof errors.PermissionViolationError) {
		return new BusError("forbidden", `not allowed on ${subject}`, {
			cause: err,
		});
	}
	return new BusError("internal", `request failed on ${subject}`, {
		cause: err,
	});
}

/** Send `body`, wait for one reply, return its result or throw its BusError. */
export async function request<TReq, TRes>(
	nc: NatsConnection,
	subject: string,
	body: TReq,
	opts: RequestOptions = {},
): Promise<TRes> {
	let msg: Msg;
	try {
		msg = await nc.request(subject, encode(body), {
			timeout: opts.timeout ?? 5000,
		});
	} catch (err) {
		throw requestFailure(err, subject);
	}
	return unwrap<TRes>(decode(msg.data));
}

export type Handler<TReq, TRes> = (req: TReq, msg: Msg) => TRes | Promise<TRes>;

export type ServeOptions = {
	/** Called with every non-BusError a handler throws (the caller only sees "internal"). */
	onError?: (err: unknown, msg: Msg) => void;
};

/**
 * Answer requests on `subject` (wildcards allowed). All servers in one
 * `queueGroup` share the load: exactly one of them answers each request.
 * The handler's return value is sent as `{result}`; a thrown BusError as `{error}`.
 */
export function serve<TReq, TRes>(
	nc: NatsConnection,
	subject: string,
	queueGroup: string,
	handler: Handler<TReq, TRes>,
	opts: ServeOptions = {},
): Subscription {
	return nc.subscribe(subject, {
		queue: queueGroup,
		callback: (err, msg) => {
			if (err) return;
			void respond(msg, handler, opts);
		},
	});
}

async function respond<TReq, TRes>(
	msg: Msg,
	handler: Handler<TReq, TRes>,
	opts: ServeOptions,
): Promise<void> {
	let reply: unknown;
	try {
		reply = { result: await handler(decode<TReq>(msg.data), msg) };
	} catch (err) {
		if (!(err instanceof BusError)) opts.onError?.(err, msg);
		reply = errorReply(err);
	}
	if (msg.reply) msg.respond(encode(reply));
}

/** Fire-and-forget event (ready notices, bead events). */
export function publish<T>(
	nc: NatsConnection,
	subject: string,
	event: T,
): void {
	nc.publish(subject, encode(event));
}

/**
 * Receive events on `subject` (wildcards allowed). Messages that are not JSON
 * are dropped. Returns the subscription; unsubscribe to stop.
 */
export function subscribe<T>(
	nc: NatsConnection,
	subject: string,
	handler: (event: T, msg: Msg) => void | Promise<void>,
): Subscription {
	return nc.subscribe(subject, {
		callback: (err, msg) => {
			if (err) return;
			let event: T;
			try {
				event = decode<T>(msg.data);
			} catch {
				return;
			}
			void Promise.resolve()
				.then(() => handler(event, msg))
				.catch(() => {});
		},
	});
}
