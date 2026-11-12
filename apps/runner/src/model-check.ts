/**
 * Does Anthropic accept the model credential of the box (mm-210.80)? One
 * request, GET /v1/models (free, no model quota), with the header the box
 * proxy sets upstream ({@link splitModelSecrets}: `Authorization: Bearer` for
 * an OAuth token from `claude setup-token`, `x-api-key` for an API key) and
 * the headers Claude Code sends with an OAuth token (seen in its requests,
 * claude-cli 2.1.322: `anthropic-version: 2023-06-01`, `anthropic-beta:
 * oauth-2025-04-20,...`). A wrong OAuth token answers 401 "OAuth access token
 * is invalid.", the same error the agent in the box gets.
 *
 * The value is never printed: the result is only accepted, refused (status)
 * or not checked (why).
 */
import {
	MODEL_SECRETS,
	MODEL_UPSTREAM,
	type ModelAuth,
	splitModelSecrets,
} from "./box/proxy.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
/** The beta header Claude Code sends with an OAuth token. */
export const OAUTH_BETA = "oauth-2025-04-20";
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

export type ModelCheck =
	| { result: "accepted" }
	| { result: "refused"; status: number }
	| { result: "unchecked"; why: string };

/** GET /v1/models with the box's upstream headers. */
export async function checkModelAuth(
	auth: Pick<ModelAuth, "header" | "value">,
	f: typeof fetch = fetch,
	upstream: string = MODEL_UPSTREAM,
): Promise<ModelCheck> {
	const headers: Record<string, string> = {
		[auth.header]: auth.value,
		"anthropic-version": ANTHROPIC_VERSION,
	};
	if (auth.header === "authorization") headers["anthropic-beta"] = OAUTH_BETA;
	try {
		const res = await f(`${upstream.replace(/\/+$/, "")}/v1/models?limit=1`, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
		await res.body?.cancel().catch(() => {});
		if (res.status === 401 || res.status === 403)
			return { result: "refused", status: res.status };
		if (res.ok) return { result: "accepted" };
		return { result: "unchecked", why: `HTTP ${res.status}` };
	} catch {
		return { result: "unchecked", why: "network" };
	}
}

/** Check one stored credential by its secret name. */
export function checkModelSecret(
	secret: (typeof MODEL_SECRETS)[number],
	value: string,
	f?: typeof fetch,
	upstream?: string,
): Promise<ModelCheck> {
	const { model } = splitModelSecrets({ [secret]: value });
	if (!model) return Promise.resolve({ result: "unchecked", why: "empty" });
	return checkModelAuth(model, f, upstream);
}

/** 'accepted' | 'refused (401)' | 'not checked (network)'. */
export function modelCheckText(c: ModelCheck): string {
	if (c.result === "accepted") return "accepted";
	if (c.result === "refused") return `refused (${c.status})`;
	return `not checked (${c.why})`;
}

/** The fix line of a refused credential. */
export function modelCredentialFix(
	secret: (typeof MODEL_SECRETS)[number],
): string {
	return secret === "CLAUDE_CODE_OAUTH_TOKEN"
		? "run claude setup-token again, then mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN"
		: `make a key at ${ANTHROPIC_KEYS_URL}, then mastermind-runner secrets set ANTHROPIC_API_KEY`;
}

/** The credential the box uses: the first of {@link MODEL_SECRETS} with a value. */
export function boxModelSecret(
	values: Record<string, string | undefined>,
): { secret: (typeof MODEL_SECRETS)[number]; value: string } | null {
	const secret = MODEL_SECRETS.find((n) => values[n]);
	return secret ? { secret, value: values[secret] as string } : null;
}
