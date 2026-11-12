/**
 * A fake api.anthropic.com for GET /v1/models: 200 for the good OAuth token
 * (Bearer, with the OAuth beta header) or the good API key, else 401 with the
 * body Anthropic sends for a wrong OAuth token. Records the headers it saw.
 */
export const GOOD_TOKEN = "sk-ant-oat01-good";
export const GOOD_KEY = "sk-ant-api03-good";

export function fakeAnthropic(o: { status?: number } = {}) {
	const seen: Headers[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			seen.push(req.headers);
			if (o.status) return new Response("{}", { status: o.status });
			const url = new URL(req.url);
			if (req.method !== "GET" || url.pathname !== "/v1/models")
				return new Response("{}", { status: 404 });
			const h = req.headers;
			const oauth =
				h.get("authorization") === `Bearer ${GOOD_TOKEN}` &&
				(h.get("anthropic-beta") ?? "").split(",").includes("oauth-2025-04-20");
			const key = h.get("x-api-key") === GOOD_KEY;
			if ((oauth || key) && h.get("anthropic-version") === "2023-06-01")
				return Response.json({ data: [{ type: "model", id: "claude-x" }] });
			return Response.json(
				{
					type: "error",
					error: {
						type: "authentication_error",
						message: "OAuth access token is invalid.",
					},
				},
				{ status: 401 },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		seen,
		stop: () => server.stop(true),
	};
}
