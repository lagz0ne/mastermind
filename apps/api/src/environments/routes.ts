/**
 * HTTP side of environments. Every route needs a session (see auth/session.ts).
 *
 *   GET  /api/environments   -> {environments, revision}
 *   PUT  /api/environments   {environments, revision} -> {environments, revision}
 *                            400 {error, errors: [{field, message}]} on bad input
 *                            409 {error, current} when revision is stale
 */
import type { RequireAccount } from "../auth/session.ts";
import { validate } from "./model.ts";
import { type EnvironmentStore, StaleEnvironments } from "./store.ts";

export type EnvironmentRoutesOptions = {
	/** Null while NATS is not ready (or not configured): 503. */
	store: () => EnvironmentStore | null;
	requireAccount: RequireAccount;
	onError?: (error: unknown) => void;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: object = {}) =>
	json({ error, ...extra }, status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
	if (!req.headers.get("content-type")?.startsWith("application/json"))
		return null;
	try {
		const b = await req.json();
		return b && typeof b === "object" && !Array.isArray(b)
			? (b as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function environmentRoutes(opts: EnvironmentRoutesOptions) {
	const guarded =
		(fn: (req: Request, store: EnvironmentStore) => Promise<Response>) =>
		async (req: Request): Promise<Response> => {
			const who = await opts.requireAccount(req);
			if (who instanceof Response) return who;
			const store = opts.store();
			if (!store)
				return fail(503, "environments are not available: NATS is not ready");
			try {
				return await fn(req, store);
			} catch (error) {
				opts.onError?.(error);
				return fail(500, "internal error");
			}
		};

	return {
		"/api/environments": {
			GET: guarded(async (_req, store) => {
				const { doc, revision } = await store.read();
				return json({ ...doc, revision });
			}),
			PUT: guarded(async (req, store) => {
				const b = await body(req);
				if (!b) return fail(400, "JSON body required");
				const revision = b.revision;
				if (!Number.isInteger(revision) || (revision as number) < 0)
					return fail(400, "revision required (0 for the first write)", {
						errors: [{ field: "revision", message: "required" }],
					});
				const v = validate(b);
				if (!v.ok)
					return fail(
						400,
						v.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
						{ errors: v.errors },
					);
				try {
					const saved = await store.write(v.doc, revision as number);
					return json({ ...saved.doc, revision: saved.revision });
				} catch (error) {
					if (error instanceof StaleEnvironments)
						return fail(
							409,
							"somebody else saved environments first; reload, then apply your change again",
							{
								current: {
									...error.current.doc,
									revision: error.current.revision,
								},
							},
						);
					throw error;
				}
			}),
		},
	};
}
