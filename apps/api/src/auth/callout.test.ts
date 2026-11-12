import { describe, expect, test } from "bun:test";
import { decode } from "@nats-io/jwt";
import { createAccount, createUser } from "@nats-io/nkeys";
import {
	type Grant,
	internalGrant,
	internalTokens,
	SERVICE_ACCOUNT_TTL_SECONDS,
	serviceAccountGrant,
	userJwt,
} from "./callout.ts";

test("a service account may answer the doctor requests and direct offers of its own account only", () => {
	const g = serviceAccountGrant(
		{ id: "0a1b2c", account: "alice", name: "laptop" } as Parameters<
			typeof serviceAccountGrant
		>[0],
		["backend"],
	);
	expect(g.permissions?.sub?.allow).toEqual([
		"_INBOX.alice.>",
		"mm.q.backend.ready",
		"mm.u.alice.r.*.doctor",
		"mm.u.alice.r.*.offer",
	]);
	expect(g.permissions?.pub?.allow).toEqual([
		"mm.u.alice.>",
		// Its account's files bucket only (mm-210.60).
		"$O.mm_files_alice.>",
		"$JS.API.STREAM.INFO.OBJ_mm_files_alice",
		"$JS.API.STREAM.MSG.GET.OBJ_mm_files_alice",
		"$JS.API.STREAM.PURGE.OBJ_mm_files_alice",
	]);
});

describe("user JWT expiry", () => {
	const issuer = createAccount();
	const user = createUser().getPublicKey();
	const now = new Date("2026-11-12T00:00:00Z");
	const claims = async (g: Grant, ttl = 60) =>
		decode(await userJwt(g, user, issuer, ttl, now));

	test("Mastermind's own connections never expire", async () => {
		const tokens = internalTokens("seed");
		for (const token of [tokens.app, tokens.sys]) {
			const grant = internalGrant(tokens, token);
			expect(grant?.expires).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: checked above
			const c = await claims(grant!);
			expect(c.exp).toBeUndefined();
			expect(c.aud).toBe(grant?.account as string);
		}
	});

	test("a service account expires after the TTL (default 24 h)", async () => {
		const g = serviceAccountGrant({
			id: "0a1b2c",
			account: "alice",
			name: "laptop",
		} as Parameters<typeof serviceAccountGrant>[0]);
		const c = await claims(g, SERVICE_ACCOUNT_TTL_SECONDS);
		expect(c.exp).toBe(now.getTime() / 1000 + 24 * 60 * 60);
		expect(c.aud).toBe("APP");
	});
});
