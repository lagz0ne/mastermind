import {
	type NatsConnection,
	type Status,
	wsconnect,
} from "@nats-io/nats-core";

export type ConnectOptions = {
	/** ws:// or wss:// URL(s). Bun's native WebSocket is the transport. */
	servers: string | string[];
	/** Connection name, shown in server monitoring (for example `mastermind-api`). */
	name: string;
	/** Token auth (runner adapters: the service account token the auth callout checks). */
	token?: string;
	/** NATS user/password auth (Mastermind's own auth-callout connection). */
	user?: string;
	pass?: string;
	/**
	 * Inbox prefix for replies. A scoped service account may only subscribe
	 * to its own inboxes, for example `_INBOX.<account>`.
	 */
	inboxPrefix?: string;
	/** Called on every connection status change: disconnect, reconnect, errors. */
	onStatus?: (status: Status) => void;
	/** How long the first connect may take, ms. */
	timeout?: number;
	/**
	 * Keep reconnecting after authorization errors. nats.js closes a connection
	 * for good after two auth errors (they need not be in a row: it never forgets
	 * the last one). Mastermind's own connections log in through Mastermind's auth
	 * callout, which is briefly not serving after every NATS restart, so for them
	 * an auth error is temporary: set this. A runner keeps the default, because
	 * there an auth error means a revoked credential.
	 */
	retryAuthErrors?: boolean;
};

/** Wait between reconnect attempts: 2 s plus up to 1 s of jitter, forever. */
export const RECONNECT_WAIT_MS = 2_000;
export const RECONNECT_JITTER_MS = 1_000;

/**
 * Connect over WebSocket. The first connect fails fast (the caller decides to
 * retry); after that the client reconnects forever, so a runner survives laptop
 * sleep and network changes, and Mastermind survives a NATS restart.
 */
export async function connect(opts: ConnectOptions): Promise<NatsConnection> {
	const nc = await wsconnect({
		servers: opts.servers,
		name: opts.name,
		token: opts.token,
		user: opts.user,
		pass: opts.pass,
		inboxPrefix: opts.inboxPrefix,
		timeout: opts.timeout,
		maxReconnectAttempts: -1,
		reconnectTimeWait: RECONNECT_WAIT_MS,
		reconnectJitter: RECONNECT_JITTER_MS,
		ignoreAuthErrorAbort: opts.retryAuthErrors ?? false,
	});
	const onStatus = opts.onStatus;
	if (onStatus) {
		(async () => {
			for await (const status of nc.status()) onStatus(status);
		})().catch(() => {});
	}
	return nc;
}
