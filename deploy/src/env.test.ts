import { expect, test } from "bun:test";
import { mergeEnv, parseEnv, serializeEnv } from "./env.ts";

test("parseEnv reads KEY=VALUE lines and keeps '=' inside values", () => {
	const env = parseEnv(
		"# comment\nA=1\n\nURL=postgres://u:p@h/db?x=1\n  B = 2\nnot a pair\n",
	);
	expect([...env]).toEqual([
		["A", "1"],
		["URL", "postgres://u:p@h/db?x=1"],
		["B", " 2"],
	]);
	expect(parseEnv(null).size).toBe(0);
});

test("serializeEnv round-trips", () => {
	const text = "A=1\nURL=mysql://root:pw@host:3306/db";
	expect(serializeEnv(parseEnv(text))).toBe(text);
});

test("keep never replaces an existing secret and makes a missing one once", () => {
	let made = 0;
	const make = () => `secret-${++made}`;
	const first = mergeEnv(parseEnv("OTHER=x"), { keep: { PASSWORD: make } });
	expect(first.changed).toEqual(["PASSWORD"]);
	expect(first.env.get("PASSWORD")).toBe("secret-1");

	const second = mergeEnv(first.env, { keep: { PASSWORD: make } });
	expect(second.changed).toEqual([]);
	expect(second.env.get("PASSWORD")).toBe("secret-1");
	expect(made).toBe(1);
});

test("set overwrites, reports only real changes, and leaves unknown keys alone", () => {
	const { env, changed } = mergeEnv(
		parseEnv("DATABASE_URL=keep-me\nNATS_URL=old\nSAME=1"),
		{
			set: { NATS_URL: "new", SAME: "1" },
		},
	);
	expect(changed).toEqual(["NATS_URL"]);
	expect(env.get("DATABASE_URL")).toBe("keep-me");
	expect(env.get("NATS_URL")).toBe("new");
});
