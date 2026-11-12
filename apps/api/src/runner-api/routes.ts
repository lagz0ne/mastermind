/**
 * Routes for runner adapters, with the service account credential
 * (`Authorization: Bearer <credential>`), not a browser session.
 *
 *   GET /api/runner/environments -> {environments: [{name, secrets, runtime?, repo?, ref?}]}
 *       401 when the credential is invalid or revoked
 *       503 while auth or the environments store is not ready
 *
 * The runner learns which secret NAMES its environments need (mm-210.51), so
 * it can say what is missing before a task arrives. Only names: the values
 * live on the runner machine and never reach Mastermind. With the repo and
 * ref it checks git access per environment in its readiness (mm-lnm).
 */
import type { BoxRuntime, Environment } from "@mastermind/core";
import { clientIp, RateLimit } from "../auth/rate-limit.ts";
import type { Auth } from "../auth/service.ts";
import type { EnvironmentStore } from "../environments/store.ts";

export type RunnerApiOptions = {
	/** Null while auth is not ready (or off): 503. */
	auth: () => Pick<Auth, "authorize"> | null;
	/** Null while NATS is not ready: 503. */
	environments: () => Pick<EnvironmentStore, "read"> | null;
	onError?: (error: unknown) => void;
};

const json = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

/**
 * Name and secret names of each environment, its box runtime when it asks
 * for one (readiness: an engine without it is not ready for it), and its repo
 * and ref when it has a repo (readiness: git access check).
 */
export function environmentSecrets(environments: Environment[]): {
	name: string;
	secrets: string[];
	runtime?: BoxRuntime;
	repo?: string;
	ref?: string;
}[] {
	return environments.map((e) => ({
		name: e.name,
		secrets: [...new Set(e.secrets ?? [])],
		...(e.runtime ? { runtime: e.runtime } : {}),
		...(e.repo ? { repo: e.repo, ref: e.ref ?? "" } : {}),
	}));
}

export function runnerApiRoutes(opts: RunnerApiOptions) {
	const limit = new RateLimit(60, 60_000);
	return {
		"/api/runner/environments": {
			GET: async (req: Request): Promise<Response> => {
				if (!limit.take(clientIp(req)))
					return json({ error: "too many requests; wait a minute" }, 429);
				const auth = opts.auth();
				const store = opts.environments();
				if (!auth || !store)
					return json({ error: "not ready: auth or NATS is starting" }, 503);
				try {
					const credential = /^Bearer\s+(\S+)$/i.exec(
						req.headers.get("authorization") ?? "",
					)?.[1];
					const sa = credential ? await auth.authorize(credential) : null;
					if (!sa)
						return json({ error: "credential is invalid or revoked" }, 401);
					const { doc } = await store.read();
					return json({ environments: environmentSecrets(doc.environments) });
				} catch (error) {
					opts.onError?.(error);
					return json({ error: "internal error" }, 500);
				}
			},
		},
	};
}
