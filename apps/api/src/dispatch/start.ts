// Where the dispatcher's NATS connection comes from.
import type { NatsConnection } from "@nats-io/nats-core";

/**
 * It must be in the account where adapters' subjects live (APP), so that it
 * may serve mm.u.*.
 */
export type DispatchNats =
	/** A connection someone else owns, such as auth's APP connection. Not closed on stop. */
	| { connection: Promise<NatsConnection> }
	/** Our own ws:// or wss:// connection (local and dev, without auth). */
	| { url: string; user?: string; pass?: string };
