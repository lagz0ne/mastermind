import { BusError, type Store } from "@mastermind/bus";
import {
	EMPTY_ROUTING,
	parseStored,
	ROUTING_KEY,
	type RoutingDoc,
	type RoutingState,
} from "./model.ts";

/** The part of a KV {@link Store} that routing uses. */
export type RoutingKv = Pick<Store<unknown>, "get" | "create" | "update">;

/** Thrown when a write is based on a revision that is no longer current. */
export class StaleRevision extends Error {
	override name = "StaleRevision";
	constructor(readonly current: RoutingState) {
		super(`routing changed: it is now at revision ${current.revision}`);
	}
}

/** The routing document in KV, read and written with compare-and-set. */
export class RoutingStore {
	constructor(private readonly kv: RoutingKv) {}

	async read(): Promise<RoutingState> {
		const e = await this.kv.get(ROUTING_KEY);
		return e
			? { doc: parseStored(e.value), revision: e.revision }
			: { doc: EMPTY_ROUTING, revision: 0 };
	}

	/**
	 * Write `doc` if the stored document is still at `revision` (0: never
	 * written). Throws {@link StaleRevision} with the current state otherwise.
	 */
	async write(doc: RoutingDoc, revision: number): Promise<RoutingState> {
		try {
			const next =
				revision === 0
					? await this.kv.create(ROUTING_KEY, doc)
					: await this.kv.update(ROUTING_KEY, doc, revision);
			return { doc, revision: next };
		} catch (err) {
			if (err instanceof BusError && err.code === "conflict")
				throw new StaleRevision(await this.read());
			throw err;
		}
	}
}
