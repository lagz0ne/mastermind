/**
 * mm-210.80: the box's model credential is checked with Anthropic using the
 * header the box proxy sets upstream (fake Anthropic answering 401 and 200).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	boxModelSecret,
	checkModelAuth,
	checkModelSecret,
	modelCheckText,
	modelCredentialFix,
} from "../src/model-check.ts";
import { fakeAnthropic, GOOD_KEY, GOOD_TOKEN } from "./fake-anthropic.ts";

const api = fakeAnthropic();
afterAll(() => api.stop());

describe("model credential check", () => {
	test("OAuth token: Bearer + the OAuth beta header; good accepted, wrong refused (401)", async () => {
		const ok = await checkModelSecret(
			"CLAUDE_CODE_OAUTH_TOKEN",
			GOOD_TOKEN,
			fetch,
			api.url,
		);
		expect(ok).toEqual({ result: "accepted" });
		const h = api.seen.at(-1) as Headers;
		expect(h.get("authorization")).toBe(`Bearer ${GOOD_TOKEN}`);
		expect(h.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(h.get("x-api-key")).toBeNull();
		const bad = await checkModelSecret(
			"CLAUDE_CODE_OAUTH_TOKEN",
			"sk-ant-oat01-wrong",
			fetch,
			api.url,
		);
		expect(bad).toEqual({ result: "refused", status: 401 });
		expect(modelCheckText(bad)).toBe("refused (401)");
	});

	test("API key: x-api-key, no OAuth beta", async () => {
		expect(
			await checkModelSecret("ANTHROPIC_API_KEY", GOOD_KEY, fetch, api.url),
		).toEqual({ result: "accepted" });
		const h = api.seen.at(-1) as Headers;
		expect(h.get("x-api-key")).toBe(GOOD_KEY);
		expect(h.get("authorization")).toBeNull();
		expect(h.get("anthropic-beta")).toBeNull();
	});

	test("no answer or a server error: not checked, never refused", async () => {
		const down = await checkModelAuth(
			{ header: "authorization", value: "Bearer x" },
			fetch,
			"http://127.0.0.1:1",
		);
		expect(modelCheckText(down)).toBe("not checked (network)");
		const busy = fakeAnthropic({ status: 529 });
		try {
			const r = await checkModelAuth(
				{ header: "x-api-key", value: "k" },
				fetch,
				busy.url,
			);
			expect(modelCheckText(r)).toBe("not checked (HTTP 529)");
		} finally {
			busy.stop();
		}
	});

	test("the box's credential: the OAuth token first, as the proxy uses it", () => {
		expect(
			boxModelSecret({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }),
		).toEqual({ secret: "CLAUDE_CODE_OAUTH_TOKEN", value: "t" });
		expect(boxModelSecret({ OTHER: "x" })).toBeNull();
		expect(modelCredentialFix("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
			"run claude setup-token again, then mastermind-runner secrets set CLAUDE_CODE_OAUTH_TOKEN",
		);
	});
});
