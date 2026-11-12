/**
 * NATS connection state for GET /api/debug/state: current state, reconnect
 * count and the last error, read from each connection's status stream.
 */
import { errors, type NatsConnection } from "@nats-io/nats-core";

export type ConnectionView = {
	name: string;
	state: "connected" | "reconnecting" | "draining" | "closed";
	server: string | null;
	reconnects: number;
	disconnects: number;
	/** Drops because the user JWT expired ('User Authentication Expired'). */
	expiries: number;
	lastError: string | null;
	lastErrorAt: string | null;
	lastChangeAt: string | null;
};

export class ConnectionWatch {
	readonly #entries = new Map<
		string,
		{ nc: NatsConnection; view: ConnectionView; reconnecting: boolean }
	>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	/** Track `nc` under `name` (a later watch of the same name replaces it). */
	watch(name: string, nc: NatsConnection): void {
		const e = {
			nc,
			reconnecting: false,
			view: {
				name,
				state: "connected" as const,
				server: null,
				reconnects: 0,
				disconnects: 0,
				expiries: 0,
				lastError: null,
				lastErrorAt: null,
				lastChangeAt: null,
			} as ConnectionView,
		};
		this.#entries.set(name, e);
		void (async () => {
			try {
				for await (const s of nc.status()) {
					const at = this.now().toISOString();
					switch (s.type) {
						case "disconnect":
							e.view.disconnects += 1;
							e.reconnecting = true;
							e.view.lastChangeAt = at;
							break;
						case "reconnecting":
							e.reconnecting = true;
							break;
						case "reconnect":
							e.view.reconnects += 1;
							e.reconnecting = false;
							e.view.lastChangeAt = at;
							break;
						case "error":
							if (s.error instanceof errors.UserAuthenticationExpiredError)
								e.view.expiries += 1;
							e.view.lastError = String(s.error?.message ?? s.error);
							e.view.lastErrorAt = at;
							break;
						case "close":
							e.view.lastChangeAt = at;
							break;
					}
				}
			} catch {
				// The status stream ends with the connection.
			}
		})();
	}

	list(): ConnectionView[] {
		return [...this.#entries.values()].map(({ nc, view, reconnecting }) => ({
			...view,
			state: nc.isClosed()
				? "closed"
				: nc.isDraining()
					? "draining"
					: reconnecting
						? "reconnecting"
						: "connected",
			server: nc.isClosed() ? null : safe(() => nc.getServer()),
		}));
	}
}

function safe(fn: () => string): string | null {
	try {
		return fn() || null;
	} catch {
		return null;
	}
}
