/**
 * Enrolment: spend a single-use enrol token (`mme_...`, minted by the account
 * in Mastermind) at `POST <mastermind>/api/auth/enrol` and get the long-lived
 * service account credential this runner connects to NATS with.
 */
import {
	defaultSettings,
	type RunnerConfig,
	type RunnerSettings,
} from "./config.ts";

/** Reply of POST /api/auth/enrol (apps/api/src/auth/routes.ts). */
export type EnrolReply = {
	account: string;
	serviceAccount: { id: string; account: string; name: string };
	credential: string;
	natsUrl: string | null;
	inboxPrefix: string;
};

export class EnrolError extends Error {
	override name = "EnrolError";
}

export type EnrolOptions = {
	/** Public origin of Mastermind (`https://host`). */
	mastermindUrl: string;
	token: string;
	/** Overrides the NATS URL that Mastermind returns. */
	natsUrl?: string;
	/** Settings to store; `id` defaults to the service account name. */
	settings?: Partial<RunnerSettings>;
	fetch?: typeof fetch;
	now?: () => Date;
};

/** Origin without a trailing slash; throws on anything but http(s). */
export function normalizeUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new EnrolError(`not a URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new EnrolError(`Mastermind URL must be http(s): ${raw}`);
	return url.href.replace(/\/+$/, "");
}

export async function enrol(opts: EnrolOptions): Promise<RunnerConfig> {
	const base = normalizeUrl(opts.mastermindUrl);
	const doFetch = opts.fetch ?? fetch;
	let res: Response;
	try {
		res = await doFetch(`${base}/api/auth/enrol`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: opts.token }),
		});
	} catch (error) {
		throw new EnrolError(`cannot reach ${base}: ${error}`);
	}
	const body = (await res.json().catch(() => null)) as
		| (EnrolReply & { error?: string })
		| null;
	if (!res.ok || !body || typeof body.credential !== "string") {
		throw new EnrolError(
			`enrol failed (${res.status}): ${body?.error ?? res.statusText}`,
		);
	}
	const natsUrl = opts.natsUrl ?? body.natsUrl;
	if (!natsUrl) {
		throw new EnrolError(
			"Mastermind returned no NATS URL; pass --nats-url or set MASTERMIND_NATS_URL",
		);
	}
	const settings: RunnerSettings = {
		...defaultSettings(body.serviceAccount.name),
		...opts.settings,
	};
	return {
		version: 1,
		mastermindUrl: base,
		natsUrl,
		account: body.account,
		serviceAccount: {
			id: body.serviceAccount.id,
			name: body.serviceAccount.name,
		},
		credential: body.credential,
		inboxPrefix: body.inboxPrefix,
		state: "active",
		enrolledAt: (opts.now?.() ?? new Date()).toISOString(),
		runner: settings,
	};
}
