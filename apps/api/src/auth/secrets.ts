import { timingSafeEqual } from "node:crypto";

/**
 * Secret strings that Mastermind hands out. The prefix tells the kind, so a
 * token of one kind never matches a lookup of another kind.
 *
 *   mml_<secret>                      login token (single use)
 *   mme_<secret>                      enrol token (single use)
 *   mms_<account>_<id>_<secret>       service account credential (long-lived)
 *   mmi_<hmac>                        Mastermind's own NATS connections
 *
 * Only sha256 hashes of these are stored.
 */

/** 32 random bytes, base64url. */
export function randomSecret(bytes = 32): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
		"base64url",
	);
}

/** Short random id (lowercase hex), safe as a NATS subject token. */
export function randomId(bytes = 5): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
		"hex",
	);
}

export function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Keyed hash: derive stable secrets (internal tokens, CSRF secret) from one seed. */
export function hmac(key: string, message: string): string {
	return new Bun.CryptoHasher("sha256", key)
		.update(message)
		.digest("base64url");
}

/** Constant-time string compare. */
export function sameSecret(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Account ids are names chosen by a human (`alice`). They appear in NATS
 * subjects (`mm.u.<account>.>`), in claim actors (`<account>/<agent>`) and in
 * credentials, so: lowercase letters, digits and '-', 1 to 32 chars.
 */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Service account names: the same rule (`laptop`, `ci-runner`). */
export const NAME = ACCOUNT_ID;

export function isAccountId(value: unknown): value is string {
	return typeof value === "string" && ACCOUNT_ID.test(value);
}

export function isName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

export type Credential = { account: string; id: string; secret: string };

export function formatCredential(c: Credential): string {
	return `mms_${c.account}_${c.id}_${c.secret}`;
}

const CREDENTIAL =
	/^mms_([a-z0-9][a-z0-9-]{0,31})_([0-9a-f]+)_([A-Za-z0-9_-]+)$/;

export function parseCredential(value: string): Credential | null {
	const m = CREDENTIAL.exec(value);
	if (!m) return null;
	const [, account, id, secret] = m as unknown as [
		string,
		string,
		string,
		string,
	];
	return { account, id, secret };
}
