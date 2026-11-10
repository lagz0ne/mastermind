import { type Health, isHealthy, type Probe } from "@mastermind/core";
import type { JetStreamHealth } from "./backup/start.ts";

export type Deps = {
	/** Probe of the dispatcher's NATS connection; null while the dispatcher is off. */
	nats: (() => Promise<Probe>) | null;
	/** Probe of the NATS work store; null without NATS. */
	work: (() => Promise<Probe>) | null;
	/** JetStream storage use (warn above 80%) and the last backup; absent without auth's NATS. */
	jetstream?: (() => Promise<JetStreamHealth>) | null;
};

export const noDeps: Deps = { nats: null, work: null };

async function probe(check: (() => Promise<Probe>) | null): Promise<Probe> {
	if (!check) return "unconfigured";
	return check().catch(() => "down");
}

export async function health(deps: Deps, version: string): Promise<Response> {
	const [nats, work, jetstream] = await Promise.all([
		probe(deps.nats),
		probe(deps.work),
		deps.jetstream?.().catch(() => undefined),
	]);
	// `jetstream` is a warning: it never makes health a 503.
	const body: Health & { jetstream?: JetStreamHealth } = {
		ok: isHealthy(nats, work),
		version,
		nats,
		work,
		...(jetstream ? { jetstream } : {}),
	};
	return Response.json(body, { status: body.ok ? 200 : 503 });
}
