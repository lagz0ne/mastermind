import { BusError, type Store } from "@mastermind/bus";
import { normalizeCode, randomCode } from "./code.ts";
import {
	ACCOUNT_ID_RULE,
	accountIdOf,
	formatCredential,
	isName,
	parseCredential,
	randomId,
	randomSecret,
	sameSecret,
	sha256,
} from "./secrets.ts";

/**
 * Identity, owned by Mastermind (no external identity provider):
 *
 *   account          a human. Id = the name in subjects and claim actors.
 *   service account  a non-human identity owned by one account. A runner
 *                    adapter connects to NATS with its credential.
 *
 * A browser logs in with a single-use code that an approver approves (the
 * operator, or a logged-in account); the first login of a new name creates
 * the account. A single-use enrol token gives a runner a
 * service account credential. Tokens, sessions and credentials are stored
 * only as sha256 hashes.
 */

/** The part of {@link Store} that auth uses (a JetStream KV bucket in production). */
export type Kv<T> = Pick<
	Store<T>,
	"get" | "create" | "update" | "put" | "delete" | "consume" | "list"
>;

export type Account = {
	id: string;
	/**
	 * The name in the case the person typed it (`Lagz0ne` for id `lagz0ne`).
	 * Absent on accounts made before display names, and when it equals the id.
	 */
	displayName?: string;
	createdAt: string;
	invitedBy: string | null;
};

export type ServiceAccount = {
	id: string;
	account: string;
	name: string;
	createdAt: string;
	secretHash: string;
};

/** A service account as the owner sees it (no hash). */
export type ServiceAccountView = Omit<ServiceAccount, "secretHash">;

export type TokenRecord =
	| { kind: "enrol"; account: string; name: string }
	/**
	 * A login started in a browser (login by code). Key: hash of the code.
	 * `browser`: hash of the secret in that browser's cookie; only that
	 * browser collects the session. `approved` is set once, by an approver.
	 */
	| {
			kind: "pending";
			browser: string;
			createdAt: string;
			userAgent: string;
			approved: Approval | null;
	  };

export type Approval = {
	account: string;
	/** The name as typed, when its case differs from the id. */
	displayName?: string;
	create: boolean;
	by: string | null;
};

export type Approver =
	| { kind: "operator" }
	| { kind: "account"; account: string };

/** What the approver sees, so that they can refuse a stranger's code. */
export type ApproveResult = {
	account: string;
	created: boolean;
	ageSeconds: number;
	userAgent: string;
};

export type PollResult =
	| { status: "pending"; expiresAt: string }
	| { status: "expired" }
	| { status: "approved"; account: string; sessionId: string };

/** A pending login lives this long. */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;

export type Session = { account: string; createdAt: string };

export type AuthStores = {
	accounts: Kv<Account>;
	serviceAccounts: Kv<ServiceAccount>;
	tokens: Kv<TokenRecord>;
	sessions: Kv<Session>;
};

/** KV buckets and their TTLs. */
export const BUCKETS = {
	accounts: { name: "mm_accounts" },
	serviceAccounts: { name: "mm_service_accounts" },
	tokens: { name: "mm_tokens", ttlMs: 24 * 60 * 60 * 1000 },
	sessions: { name: "mm_sessions", ttlMs: 30 * 24 * 60 * 60 * 1000 },
} as const;

export type AuthErrorCode =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "not_found";

export class AuthError extends Error {
	override name = "AuthError";
	constructor(
		readonly code: AuthErrorCode,
		message: string,
	) {
		super(message);
	}
}

const pendingKey = (code: string) => `pending.${sha256(code)}`;
/** One answer for a wrong, used and expired code: never say which. */
const noSuchCode = () => new AuthError("not_found", "no such code");
const tokenKey = (kind: "enrol", token: string) => `${kind}.${sha256(token)}`;
const saKey = (account: string, id: string) => `${account}.${id}`;
const isConflict = (err: unknown) =>
	err instanceof BusError && err.code === "conflict";

export type AuthOptions = {
	/** Called after a service account is deleted: disconnect its clients. */
	onRevoke?: (sa: ServiceAccountView) => Promise<void>;
	now?: () => Date;
};

export class Auth {
	private readonly now: () => Date;

	constructor(
		private readonly stores: AuthStores,
		private readonly opts: AuthOptions = {},
	) {
		this.now = opts.now ?? (() => new Date());
	}

	/**
	 * A browser starts a login: a code to read aloud, and a secret for that
	 * browser's cookie (`<code>.<secret>`). Only hashes are stored.
	 */
	async startLogin(
		userAgent: string,
	): Promise<{ code: string; cookie: string; expiresAt: string }> {
		const secret = randomSecret();
		const createdAt = this.now();
		for (;;) {
			const code = randomCode();
			try {
				await this.stores.tokens.create(pendingKey(code), {
					kind: "pending",
					browser: sha256(secret),
					createdAt: createdAt.toISOString(),
					userAgent: userAgent.slice(0, 200),
					approved: null,
				});
			} catch (err) {
				if (isConflict(err)) continue;
				throw err;
			}
			return {
				code,
				cookie: `${code}.${secret}`,
				expiresAt: new Date(
					createdAt.getTime() + LOGIN_CODE_TTL_MS,
				).toISOString(),
			};
		}
	}

	/**
	 * Approve the login of `code` for `name`. The name is trimmed and
	 * lowercased to the account id (`Lagz0ne` -> `lagz0ne`); a name in mixed
	 * case is kept as the display name. The operator may name any account (it
	 * is created when missing). A logged-in account approves for itself
	 * (another device) or for a new account name (an invite). Of many
	 * concurrent approvals, one wins.
	 */
	async approveLogin(
		codeInput: string,
		name: string,
		approver: Approver,
	): Promise<ApproveResult> {
		const account = accountIdOf(name);
		if (!account) throw new AuthError("bad_request", ACCOUNT_ID_RULE);
		const typed = name.trim();
		const display = typed !== account ? { displayName: typed } : {};
		const exists = (await this.stores.accounts.get(account)) !== null;
		let approval: Approval;
		if (approver.kind === "operator")
			approval = { account, ...display, create: !exists, by: null };
		else if (approver.account === account)
			approval = { account, ...display, create: false, by: account };
		else if (exists)
			throw new AuthError(
				"forbidden",
				`account ${account} exists; only it can approve its own logins`,
			);
		else approval = { account, ...display, create: true, by: approver.account };

		const code = normalizeCode(codeInput);
		if (!code) throw noSuchCode();
		const e = await this.stores.tokens.get(pendingKey(code));
		if (
			e?.value.kind !== "pending" ||
			e.value.approved ||
			this.expired(e.value)
		)
			throw noSuchCode();
		try {
			await this.stores.tokens.update(
				pendingKey(code),
				{ ...e.value, approved: approval },
				e.revision,
			);
		} catch (err) {
			if (isConflict(err)) throw noSuchCode();
			throw err;
		}
		return {
			account,
			created: approval.create,
			ageSeconds: Math.max(
				0,
				Math.round(
					(this.now().getTime() - Date.parse(e.value.createdAt)) / 1000,
				),
			),
			userAgent: e.value.userAgent,
		};
	}

	/**
	 * The browser that started a login asks with its cookie. Once approved,
	 * the pending login is consumed (one winner) and a session is made.
	 */
	async pollLogin(cookie: string | null | undefined): Promise<PollResult> {
		const [codePart, secret] = (cookie ?? "").split(".", 2);
		const code = normalizeCode(codePart ?? "");
		if (!code || !secret) return { status: "expired" };
		const key = pendingKey(code);
		const e = await this.stores.tokens.get(key);
		if (
			e?.value.kind !== "pending" ||
			!sameSecret(e.value.browser, sha256(secret)) ||
			this.expired(e.value)
		)
			return { status: "expired" };
		const { approved } = e.value;
		if (!approved)
			return {
				status: "pending",
				expiresAt: new Date(
					Date.parse(e.value.createdAt) + LOGIN_CODE_TTL_MS,
				).toISOString(),
			};
		try {
			await this.stores.tokens.delete(key, e.revision);
		} catch (err) {
			if (isConflict(err)) return { status: "expired" };
			throw err;
		}
		let made = false;
		if (approved.create) {
			try {
				await this.stores.accounts.create(approved.account, {
					id: approved.account,
					...(approved.displayName && { displayName: approved.displayName }),
					createdAt: this.now().toISOString(),
					invitedBy: approved.by,
				});
				made = true;
			} catch (err) {
				if (!isConflict(err)) throw err;
				// The operator may log in to an account made meanwhile; an
				// invite of a name taken meanwhile fails.
				if (approved.by !== null)
					throw new AuthError("conflict", `account ${approved.account} exists`);
			}
		}
		if (!made) {
			const a = await this.stores.accounts.get(approved.account);
			if (!a) return { status: "expired" };
			// The operator or the account itself typed the name in a new case:
			// that is the display name from now on. Lowercase typing keeps it.
			if (approved.displayName && a.value.displayName !== approved.displayName)
				try {
					await this.stores.accounts.update(
						approved.account,
						{ ...a.value, displayName: approved.displayName },
						a.revision,
					);
				} catch (err) {
					// A concurrent change wins; the login goes on.
					if (!isConflict(err)) throw err;
				}
		}
		const sessionId = randomSecret();
		await this.stores.sessions.create(sha256(sessionId), {
			account: approved.account,
			createdAt: this.now().toISOString(),
		});
		return { status: "approved", account: approved.account, sessionId };
	}

	private expired(p: { createdAt: string }): boolean {
		return this.now().getTime() - Date.parse(p.createdAt) >= LOGIN_CODE_TTL_MS;
	}

	/** The account behind a session cookie, or null. */
	async session(sessionId: string | null | undefined): Promise<string | null> {
		if (!sessionId) return null;
		const s = await this.stores.sessions.get(sha256(sessionId));
		return s?.value.account ?? null;
	}

	async logout(sessionId: string): Promise<void> {
		await this.stores.sessions.delete(sha256(sessionId));
	}

	/** An account mints an enrol token for a new service account of its own. */
	async enrolToken(account: string, name: string): Promise<string> {
		if (!isName(name))
			throw new AuthError("bad_request", "bad service account name");
		const token = `mme_${randomSecret()}`;
		await this.stores.tokens.create(tokenKey("enrol", token), {
			kind: "enrol",
			account,
			name,
		});
		return token;
	}

	/**
	 * A runner adapter spends an enrol token and gets a long-lived service
	 * account credential. Only its hash is stored. Single use, like login.
	 */
	async enrol(token: string): Promise<{
		serviceAccount: ServiceAccountView;
		credential: string;
	} | null> {
		if (!token.startsWith("mme_")) return null;
		const rec = await this.stores.tokens.consume(tokenKey("enrol", token));
		if (rec?.kind !== "enrol") return null;
		const secret = randomSecret();
		const sa: ServiceAccount = {
			id: randomId(),
			account: rec.account,
			name: rec.name,
			createdAt: this.now().toISOString(),
			secretHash: sha256(secret),
		};
		await this.stores.serviceAccounts.create(saKey(sa.account, sa.id), sa);
		return {
			serviceAccount: view(sa),
			credential: formatCredential({ account: sa.account, id: sa.id, secret }),
		};
	}

	/** Check a service account credential (the NATS auth callout calls this). */
	async authorize(credential: string): Promise<ServiceAccountView | null> {
		const c = parseCredential(credential);
		if (!c) return null;
		const e = await this.stores.serviceAccounts.get(saKey(c.account, c.id));
		if (!e || !sameSecret(e.value.secretHash, sha256(c.secret))) return null;
		return view(e.value);
	}

	/** Service accounts of `account`; of every account when omitted. */
	async serviceAccounts(account?: string): Promise<ServiceAccountView[]> {
		const keys = await this.stores.serviceAccounts.list(
			account === undefined ? undefined : `${account}.*`,
		);
		const entries = await Promise.all(
			keys.map((k) => this.stores.serviceAccounts.get(k)),
		);
		return entries.flatMap((e) => (e ? [view(e.value)] : []));
	}

	/** The name to show for an account: its display name, else its id. */
	async displayName(id: string): Promise<string> {
		return (await this.stores.accounts.get(id))?.value.displayName ?? id;
	}

	/** Every account, oldest first. */
	async accounts(): Promise<Account[]> {
		const keys = await this.stores.accounts.list();
		const entries = await Promise.all(
			keys.map((k) => this.stores.accounts.get(k)),
		);
		return entries
			.flatMap((e) => (e ? [e.value] : []))
			.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
	}

	/** Delete a service account of `account` and disconnect its clients. */
	async revoke(account: string, id: string): Promise<boolean> {
		const key = saKey(account, id);
		const e = await this.stores.serviceAccounts.get(key);
		if (!e) return false;
		await this.stores.serviceAccounts.delete(key);
		await this.opts.onRevoke?.(view(e.value));
		return true;
	}
}

function view(sa: ServiceAccount): ServiceAccountView {
	const { secretHash: _, ...rest } = sa;
	return rest;
}
