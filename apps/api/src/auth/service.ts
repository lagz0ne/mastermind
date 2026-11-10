import { BusError, type Store } from "@mastermind/bus";
import { normalizeCode, randomCode } from "./code.ts";
import {
	formatCredential,
	isAccountId,
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
 * Both start from single-use tokens. A login token gives a browser session
 * (and creates the account on first use). An enrol token gives a runner a
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
	/** `create`: the account does not exist yet; the first login creates it. */
	| { kind: "login"; account: string; create: boolean; by: string | null }
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
	  }
	/**
	 * Points at the current first-start token (`key`: its token key). Older
	 * markers have no key.
	 */
	| { kind: "bootstrap"; key?: string };

/** Who approved a pending login, for which account. `by` null = the operator. */
export type Approval = { account: string; create: boolean; by: string | null };

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

const BOOTSTRAP_KEY = "bootstrap";
const pendingKey = (code: string) => `pending.${sha256(code)}`;
/** One answer for a wrong, used and expired code: never say which. */
const noSuchCode = () => new AuthError("not_found", "no such code");
const tokenKey = (kind: "login" | "enrol", token: string) =>
	`${kind}.${sha256(token)}`;
const saKey = (account: string, id: string) => `${account}.${id}`;
const isConflict = (err: unknown) =>
	err instanceof BusError && err.code === "conflict";

export type AuthOptions = {
	/** Id of the first account. Default `admin`. */
	firstAccount?: string;
	/** Called after a service account is deleted: disconnect its clients. */
	onRevoke?: (sa: ServiceAccountView) => Promise<void>;
	now?: () => Date;
};

export class Auth {
	private readonly firstAccount: string;
	private readonly now: () => Date;

	constructor(
		private readonly stores: AuthStores,
		private readonly opts: AuthOptions = {},
	) {
		this.firstAccount = opts.firstAccount ?? "admin";
		this.now = opts.now ?? (() => new Date());
		if (!isAccountId(this.firstAccount))
			throw new AuthError("bad_request", "bad first account id");
	}

	/**
	 * First start: while no account exists, EVERY start mints a new login
	 * token for the first account and returns it (the caller logs the URL).
	 * The token of the previous start stops working. Of many replicas that
	 * start together, one wins (compare-and-set on the marker). Returns null
	 * when an account exists or another replica won.
	 */
	async bootstrap(): Promise<string | null> {
		if ((await this.stores.accounts.list()).length > 0) return null;
		const old = await this.stores.tokens.get(BOOTSTRAP_KEY);
		// Mint first, then point the marker at it: a token that loses the race
		// is deleted again, and a winner's token is never deleted by a loser.
		const token = await this.mintLogin({
			account: this.firstAccount,
			create: true,
			by: null,
		});
		const marker: TokenRecord = {
			kind: "bootstrap",
			key: tokenKey("login", token),
		};
		try {
			if (old)
				await this.stores.tokens.update(BOOTSTRAP_KEY, marker, old.revision);
			else await this.stores.tokens.create(BOOTSTRAP_KEY, marker);
		} catch (err) {
			await this.stores.tokens.delete(tokenKey("login", token));
			if (isConflict(err)) return null;
			throw err;
		}
		if (old?.value.kind === "bootstrap") {
			if (old.value.key) await this.stores.tokens.delete(old.value.key);
			else await this.dropFirstStartTokens(tokenKey("login", token));
		}
		return token;
	}

	/** Older markers do not name their token: delete every first-start token but `keep`. */
	private async dropFirstStartTokens(keep: string): Promise<void> {
		for (const key of await this.stores.tokens.list("login.*")) {
			if (key === keep) continue;
			const e = await this.stores.tokens.get(key);
			if (e?.value.kind === "login" && e.value.create && e.value.by === null)
				await this.stores.tokens.delete(key, e.revision).catch(() => {});
		}
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
	 * Approve the login of `code` for `account`. The operator may name any
	 * account (it is created when missing). A logged-in account approves for
	 * itself (another device) or for a new account name (an invite). Of many
	 * concurrent approvals, one wins.
	 */
	async approveLogin(
		codeInput: string,
		account: string,
		approver: Approver,
	): Promise<ApproveResult> {
		if (!isAccountId(account))
			throw new AuthError("bad_request", "bad account id");
		const exists = (await this.stores.accounts.get(account)) !== null;
		let approval: Approval;
		if (approver.kind === "operator")
			approval = { account, create: !exists, by: null };
		else if (approver.account === account)
			approval = { account, create: false, by: account };
		else if (exists)
			throw new AuthError(
				"forbidden",
				`account ${account} exists; only it can approve its own logins`,
			);
		else approval = { account, create: true, by: approver.account };

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
		if (approved.create) {
			try {
				await this.stores.accounts.create(approved.account, {
					id: approved.account,
					createdAt: this.now().toISOString(),
					invitedBy: approved.by,
				});
			} catch (err) {
				if (!isConflict(err)) throw err;
				// The operator may log in to an account made meanwhile; an
				// invite of a name taken meanwhile fails.
				if (approved.by !== null)
					throw new AuthError("conflict", `account ${approved.account} exists`);
			}
		} else if (!(await this.stores.accounts.get(approved.account)))
			return { status: "expired" };
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

	/** A logged-in account invites a new account: a login token that creates it. */
	async invite(by: string, account: string): Promise<string> {
		if (!isAccountId(account))
			throw new AuthError("bad_request", "bad account id");
		if (await this.stores.accounts.get(account))
			throw new AuthError("conflict", `account ${account} exists`);
		return this.mintLogin({ account, create: true, by });
	}

	/** A login token for an existing account (for example a second device). */
	async loginToken(account: string): Promise<string> {
		if (!(await this.stores.accounts.get(account)))
			throw new AuthError("not_found", `no account ${account}`);
		return this.mintLogin({ account, create: false, by: account });
	}

	private async mintLogin(
		record: Omit<Extract<TokenRecord, { kind: "login" }>, "kind">,
	): Promise<string> {
		const token = `mml_${randomSecret()}`;
		await this.stores.tokens.create(tokenKey("login", token), {
			kind: "login",
			...record,
		});
		return token;
	}

	/**
	 * Spend a login token. Of many concurrent calls with the same token, at
	 * most one gets a session; the rest get null.
	 */
	async login(
		token: string,
	): Promise<{ account: string; sessionId: string } | null> {
		if (!token.startsWith("mml_")) return null;
		const rec = await this.stores.tokens.consume(tokenKey("login", token));
		if (rec?.kind !== "login") return null;
		if (rec.create) {
			try {
				await this.stores.accounts.create(rec.account, {
					id: rec.account,
					createdAt: this.now().toISOString(),
					invitedBy: rec.by,
				});
			} catch (err) {
				if (isConflict(err))
					throw new AuthError("conflict", `account ${rec.account} exists`);
				throw err;
			}
		} else if (!(await this.stores.accounts.get(rec.account))) {
			return null;
		}
		const sessionId = randomSecret();
		await this.stores.sessions.create(sha256(sessionId), {
			account: rec.account,
			createdAt: this.now().toISOString(),
		});
		return { account: rec.account, sessionId };
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
