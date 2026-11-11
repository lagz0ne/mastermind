import { subjects } from "@mastermind/bus";
import {
	decode,
	encodeAuthorizationResponse,
	encodeUser,
	type Permissions,
} from "@nats-io/jwt";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { KeyPair } from "@nats-io/nkeys";
import { hmac, sameSecret } from "./secrets.ts";
import type { ServiceAccountView } from "./service.ts";

/**
 * NATS auth callout (nats.conf: `authorization.auth_callout`, accounts AUTH,
 * APP, SYS). The server sends every client CONNECT to $SYS.REQ.USER.AUTH;
 * Mastermind answers with a user JWT signed by the issuer key, or an error.
 *
 *   service account   APP, pub mm.u.<account>.>, sub _INBOX.<account>.>,
 *                     the ready signals of its queues and the doctor
 *                     requests of its account's runners
 *   mastermind app    APP, no limits (KV buckets, dispatcher)
 *   mastermind sys    SYS (connz + kick, to disconnect revoked clients)
 */

export const CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

/** What the callout gives a client: a target account and permissions. */
export type Grant = {
	/** User name in the JWT; NATS monitoring shows it as `authorized_user`. */
	name: string;
	account: "APP" | "SYS";
	permissions?: Permissions;
};

/** The JWT user name of a service account: `<account>/<id>`. */
export const serviceAccountUser = (sa: { account: string; id: string }) =>
	`${sa.account}/${sa.id}`;

/**
 * Permissions of a runner adapter. `queues`: the ready signals it may
 * subscribe to; absent means all (`mm.q.*.ready`, a signal that carries only
 * the queue name). It must use inbox prefix `_INBOX.<account>`.
 */
export function serviceAccountGrant(
	sa: ServiceAccountView,
	queues?: string[],
): Grant {
	const ready = queues
		? queues.map((q) => subjects.ready(q))
		: ["mm.q.*.ready"];
	return {
		name: serviceAccountUser(sa),
		account: "APP",
		permissions: {
			pub: { allow: [subjects.accountScope(sa.account)] },
			sub: {
				allow: [
					`_INBOX.${sa.account}.>`,
					...ready,
					subjects.runnerDoctorScope(sa.account),
				],
			},
		},
	};
}

/**
 * Tokens for Mastermind's own connections, derived from the issuer seed:
 * every replica knows them, nobody else does, no extra secret to manage.
 */
export function internalTokens(seed: string): { app: string; sys: string } {
	return {
		app: `mmi_${hmac(seed, "mastermind/app")}`,
		sys: `mmi_${hmac(seed, "mastermind/sys")}`,
	};
}

/** Grants for the internal tokens; null when `token` is not one of them. */
export function internalGrant(
	tokens: { app: string; sys: string },
	token: string,
): Grant | null {
	if (sameSecret(token, tokens.app))
		return { name: "mastermind", account: "APP" };
	if (sameSecret(token, tokens.sys))
		return { name: "mastermind-sys", account: "SYS" };
	return null;
}

/** The parts of the authorization request that Mastermind looks at. */
export type CalloutRequest = {
	user_nkey: string;
	server_id: { id: string };
	connect_opts?: { auth_token?: string; name?: string };
};

export type CalloutOptions = {
	/** Connection of the auth user (account AUTH). */
	nc: NatsConnection;
	/** Account key whose public key is `issuer` in nats.conf. */
	issuer: KeyPair;
	/** Map a CONNECT token to a grant, or null to refuse. */
	resolve: (token: string) => Promise<Grant | null>;
	/** User JWT lifetime. When it ends, the client reconnects and is checked again. */
	ttlSeconds?: number;
	onError?: (error: unknown) => void;
};

/** Answer authorization requests until the subscription is closed. */
export function serveCallout(opts: CalloutOptions): Subscription {
	const ttl = opts.ttlSeconds ?? 3600;
	const sub = opts.nc.subscribe(CALLOUT_SUBJECT);
	(async () => {
		for await (const msg of sub) {
			let req: CalloutRequest;
			try {
				req = decode<CalloutRequest>(msg.string()).nats as CalloutRequest;
			} catch (error) {
				opts.onError?.(error);
				continue;
			}
			const reply = async (data: { jwt: string } | { error: string }) =>
				msg.respond(
					await encodeAuthorizationResponse(
						req.user_nkey,
						req.server_id.id,
						opts.issuer,
						data,
						{},
					),
				);
			try {
				const token = req.connect_opts?.auth_token ?? "";
				const grant = token ? await opts.resolve(token) : null;
				if (!grant) {
					await reply({ error: "not authorized" });
					continue;
				}
				const jwt = await encodeUser(
					grant.name,
					req.user_nkey,
					opts.issuer,
					grant.permissions ?? {},
					{
						aud: grant.account,
						exp: Math.floor(Date.now() / 1000) + ttl,
					},
				);
				await reply({ jwt });
			} catch (error) {
				opts.onError?.(error);
				await reply({ error: "auth service error" }).catch(() => {});
			}
		}
	})();
	return sub;
}

type Connz = {
	server: { id: string };
	data?: { connections?: { cid: number; authorized_user?: string }[] };
};

/**
 * Disconnect every APP client logged in as `user` on every server. Needs a
 * SYS connection. Returns how many connections were kicked.
 */
export async function kick(sys: NatsConnection, user: string): Promise<number> {
	const replies = await sys.requestMany(
		"$SYS.REQ.SERVER.PING.CONNZ",
		JSON.stringify({ acc: "APP", auth: true, limit: 10_000 }),
		{ strategy: "timer", maxWait: 500 },
	);
	const targets: { server: string; cid: number }[] = [];
	for await (const m of replies) {
		const z = m.json<Connz>();
		for (const c of z.data?.connections ?? [])
			if (c.authorized_user === user)
				targets.push({ server: z.server.id, cid: c.cid });
	}
	await Promise.all(
		targets.map((t) =>
			sys.request(
				`$SYS.REQ.SERVER.${t.server}.KICK`,
				JSON.stringify({ cid: t.cid }),
				{ timeout: 2000 },
			),
		),
	);
	return targets.length;
}
