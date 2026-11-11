/**
 * The secrets state of this runner in one call (list, check, doctor, status,
 * start): fetch the needed names (cache them; on failure use the cache),
 * then look each one up locally.
 */
import type { Routing } from "../routing.ts";
import {
	fetchNeeds,
	loadNeeds,
	type Needs,
	neededSecrets,
	needsPath,
	type SecretRow,
	type SecretsDiagnostics,
	saveNeeds,
	secretRows,
	secretsDiagnostics,
} from "./needs.ts";
import { type SecretSource, SecretStore } from "./store.ts";

export type SecretsStateInput = {
	/** The secrets file (secretsPath()). */
	file: string;
	/** Absent (not enrolled): only the cache is used. */
	mastermindUrl?: string;
	credential?: string;
	routing: Pick<Routing, "environments" | "implicit">;
	env: Record<string, string | undefined>;
	fetch?: typeof fetch;
	/** Default: the file store at `file`. */
	source?: SecretSource;
};

export type SecretsState = {
	rows: SecretRow[];
	/** null: the needed names are unknown (no answer, no cache). */
	needs: Needs | null;
	/** Why the needed names are unknown or from the cache. */
	problem?: string;
	diagnostics: SecretsDiagnostics;
};

/** Fetch the needed names; on failure fall back to the last cached ones. */
export async function learnNeeds(
	i: Pick<SecretsStateInput, "file" | "mastermindUrl" | "credential" | "fetch">,
): Promise<{ needs: Needs | null; problem?: string }> {
	const cache = needsPath(i.file);
	let why = "not enrolled";
	if (i.mastermindUrl && i.credential) {
		try {
			const needs = await fetchNeeds(i.mastermindUrl, i.credential, {
				fetch: i.fetch,
			});
			await saveNeeds(cache, needs).catch(() => {});
			return { needs };
		} catch (error) {
			why = error instanceof Error ? error.message : String(error);
		}
	}
	const cached = await loadNeeds(cache);
	return cached
		? {
				needs: cached,
				problem: `${why}; using the needed names from ${cached.at}`,
			}
		: { needs: null, problem: `${why}; the needed secrets are unknown` };
}

export async function secretsState(
	i: SecretsStateInput,
): Promise<SecretsState> {
	const { needs, problem } = await learnNeeds(i);
	const needed = needs ? neededSecrets(needs, i.routing) : new Map();
	const rows = await secretRows(
		needed,
		i.source ?? new SecretStore(i.file),
		i.env,
		i.routing,
	);
	return {
		rows,
		needs,
		...(problem ? { problem } : {}),
		diagnostics: secretsDiagnostics(rows, needs?.at ?? null, problem),
	};
}
