import { expect, test } from "bun:test";
import { serviceAccountGrant } from "./callout.ts";

test("a service account may answer the doctor requests of its own account only", () => {
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
	]);
	expect(g.permissions?.pub?.allow).toEqual(["mm.u.alice.>"]);
});
