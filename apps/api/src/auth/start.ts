import { connect, Store } from "@mastermind/bus";
import type { NatsConnection } from "@nats-io/nats-core";
import { fromSeed } from "@nats-io/nkeys";
import {
	internalGrant,
	internalTokens,
	kick,
	serveCallout,
	serviceAccountGrant,
	serviceAccountUser,
} from "./callout.ts";
import { authRoutes } from "./routes.ts";
import { hmac } from "./secrets.ts";
import { Auth, type AuthStores, BUCKETS } from "./service.ts";

export type AuthConfig = {
	/** NATS URL(s) for Mastermind (internal network), ws:// or wss://. */
	natsUrl: string;
	/** The auth callout user of account AUTH (nats.conf). */
	authUser: string;
	authPassword: string;
	/** Seed (SA...) of the account key that signs callout responses. */
	issuerSeed: string;
	/** Public origin of the UI, for login links. */
	publicUrl: string;
	/** Public NATS WebSocket URL for runner adapters. */
	publicNatsUrl?: string;
	/** Id of the first account. Default `admin`. */
	firstAccount?: string;
	log?: (line: string) => void;
};

export type AuthService = {
	/** Mastermind's connection in account APP: KV, dispatcher. */
	app: NatsConnection;
	auth: Auth;
	routes: ReturnType<typeof authRoutes>;
	stop(): Promise<void>;
};

/**
 * Start auth: answer the NATS auth callout, open Mastermind's own APP and SYS
 * connections through it, open the KV buckets, and on first start log a
 * single-use login URL for the first account. On failure nothing stays open.
 */
export async function startAuth(cfg: AuthConfig): Promise<AuthService> {
	const log = cfg.log ?? console.log;
	const seed = cfg.issuerSeed.trim();
	const issuer = fromSeed(new TextEncoder().encode(seed));
	const internal = internalTokens(seed);
	let auth: Auth | null = null;
	const conns: NatsConnection[] = [];
	const close = () => Promise.allSettled(conns.map((nc) => nc.drain()));

	try {
		const callout = await connect({
			servers: cfg.natsUrl,
			name: "mastermind-auth",
			user: cfg.authUser,
			pass: cfg.authPassword,
		});
		conns.push(callout);
		serveCallout({
			nc: callout,
			issuer,
			resolve: async (token) => {
				const own = internalGrant(internal, token);
				if (own) return own;
				const sa = auth ? await auth.authorize(token) : null;
				return sa ? serviceAccountGrant(sa) : null;
			},
			onError: (error) => log(`auth: callout error: ${error}`),
		});
		await callout.flush();

		const app = await connect({
			servers: cfg.natsUrl,
			name: "mastermind",
			token: internal.app,
		});
		conns.push(app);
		const sys = await connect({
			servers: cfg.natsUrl,
			name: "mastermind-sys",
			token: internal.sys,
		});
		conns.push(sys);

		const stores: AuthStores = {
			accounts: await Store.open(app, BUCKETS.accounts.name),
			serviceAccounts: await Store.open(app, BUCKETS.serviceAccounts.name),
			tokens: await Store.open(app, BUCKETS.tokens.name, {
				ttlMs: BUCKETS.tokens.ttlMs,
			}),
			sessions: await Store.open(app, BUCKETS.sessions.name, {
				ttlMs: BUCKETS.sessions.ttlMs,
			}),
		};
		const ready = new Auth(stores, {
			firstAccount: cfg.firstAccount,
			onRevoke: async (sa) => {
				const user = serviceAccountUser(sa);
				const n = await kick(sys, user).catch((error) => {
					log(`auth: kick ${user} failed: ${error}`);
					return 0;
				});
				log(`auth: revoked ${user}, ${n} connection(s) closed`);
			},
		});
		auth = ready;

		const first = await ready.bootstrap();
		if (first)
			log(`auth: first login (single use): ${cfg.publicUrl}/login#${first}`);

		return {
			app,
			auth: ready,
			routes: routesFor(cfg, () => ready),
			stop: async () => {
				await close();
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

function routesFor(cfg: AuthConfig, auth: () => Auth | null) {
	const log = cfg.log ?? console.log;
	return authRoutes(auth, {
		publicUrl: cfg.publicUrl,
		csrfSecret: hmac(cfg.issuerSeed.trim(), "mastermind/csrf"),
		natsUrl: cfg.publicNatsUrl,
		onError: (error) => log(`auth: ${error}`),
	});
}

export type BackgroundAuth = {
	/** Mounted at once; they answer 503 until auth is ready. */
	routes: ReturnType<typeof authRoutes>;
	/** Resolves when auth runs (for example to start the dispatcher on `app`). */
	ready: Promise<AuthService>;
	stop(): Promise<void>;
};

/**
 * For the server: NATS may come up after the app, so retry with backoff
 * instead of crashing. The routes exist from the start.
 */
export function startAuthInBackground(cfg: AuthConfig): BackgroundAuth {
	const log = cfg.log ?? console.log;
	let service: AuthService | null = null;
	let stopped = false;
	const ready = (async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				const s = await startAuth(cfg);
				if (stopped) {
					await s.stop();
					throw new Error("auth stopped");
				}
				service = s;
				log("auth: ready");
				return s;
			} catch (error) {
				if (stopped) throw error;
				const wait = Math.min(1_000 * 2 ** attempt, 60_000);
				log(`auth: start failed (${error}); retrying in ${wait}ms`);
				await Bun.sleep(wait);
			}
		}
	})();
	ready.catch(() => {});
	return {
		routes: routesFor(cfg, () => service?.auth ?? null),
		ready,
		stop: async () => {
			stopped = true;
			await service?.stop();
		},
	};
}
