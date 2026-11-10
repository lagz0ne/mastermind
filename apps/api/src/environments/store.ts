import { BusError, type Store } from "@mastermind/bus";
import {
	EMPTY_ENVIRONMENTS,
	ENVIRONMENTS_KEY,
	type EnvironmentsDoc,
	type EnvironmentsState,
	parseStored,
} from "./model.ts";

/** The part of a KV {@link Store} that environments use. */
export type EnvironmentsKv = Pick<Store<unknown>, "get" | "create" | "update">;

/** Thrown when a write is based on a revision that is no longer current. */
export class StaleEnvironments extends Error {
	override name = "StaleEnvironments";
	constructor(readonly current: EnvironmentsState) {
		super(`environments changed: now at revision ${current.revision}`);
	}
}

/** The environments document in KV, read and written with compare-and-set. */
export class EnvironmentStore {
	constructor(private readonly kv: EnvironmentsKv) {}

	async read(): Promise<EnvironmentsState> {
		const e = await this.kv.get(ENVIRONMENTS_KEY);
		return e
			? { doc: parseStored(e.value), revision: e.revision }
			: { doc: EMPTY_ENVIRONMENTS, revision: 0 };
	}

	/**
	 * Write `doc` if the stored document is still at `revision` (0: never
	 * written). Throws {@link StaleEnvironments} with the current state otherwise.
	 */
	async write(
		doc: EnvironmentsDoc,
		revision: number,
	): Promise<EnvironmentsState> {
		try {
			const next =
				revision === 0
					? await this.kv.create(ENVIRONMENTS_KEY, doc)
					: await this.kv.update(ENVIRONMENTS_KEY, doc, revision);
			return { doc, revision: next };
		} catch (err) {
			if (err instanceof BusError && err.code === "conflict")
				throw new StaleEnvironments(await this.read());
			throw err;
		}
	}
}
