import { afterAll, describe, expect, test } from "bun:test";
import { checkCredential } from "../src/client.ts";

// Mimics GET /api/auth/credential of apps/api: the status is the test case.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		const status = Number(new URL(req.url).pathname.split("/")[1]);
		if (req.headers.get("authorization") !== "Bearer mms_alice_0a1b2c_s")
			return new Response("bad header", { status: 400 });
		return Response.json({}, { status });
	},
});
afterAll(() => server.stop(true));

const at = (status: number) => `http://127.0.0.1:${server.port}/${status}`;

describe("checkCredential", () => {
	test("only 401 means revoked", async () => {
		const s = "mms_alice_0a1b2c_s";
		expect(await checkCredential(at(200), s)).toBe("valid");
		expect(await checkCredential(at(401), s)).toBe("revoked");
		for (const status of [404, 429, 500, 502, 503])
			expect(await checkCredential(at(status), s)).toBe("unknown");
	});

	test("no answer is unknown", async () => {
		expect(await checkCredential("http://127.0.0.1:1", "x")).toBe("unknown");
		expect(
			await checkCredential("http://mm.invalid", "x", {
				fetch: ((_u: string, init?: RequestInit) =>
					new Promise((_, reject) =>
						init?.signal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						),
					)) as typeof fetch,
				timeoutMs: 50,
			}),
		).toBe("unknown");
	});
});
