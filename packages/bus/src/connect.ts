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
	/** Token auth (adapters: the token the auth callout checks). */
	token?: string;
	/** User/password auth (Mastermind's own auth-callout connection). */
	user?: string;
	pass?: string;
	/**
	 * Inbox prefix for replies. A scoped user may only subscribe to its own
	 * inboxes, for example `_INBOX.<user>`.
	 */
	inboxPrefix?: string;
	/** Called on every connection status change: disconnect, reconnect, errors. */
	onStatus?: (status: Status) => void;
	/** How long the first connect may take, ms. */
	timeout?: number;
};

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
	});
	const onStatus = opts.onStatus;
	if (onStatus) {
		(async () => {
			for await (const status of nc.status()) onStatus(status);
		})().catch(() => {});
	}
	return nc;
}
