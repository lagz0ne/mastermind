import { afterAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import {
	PROXY_JS,
	PROXY_READY,
	parseAllow,
	proxyEnv,
} from "../../src/box/proxy.ts";

describe("parseAllow", () => {
	test("normalises hosts, host:port, *.host", () => {
		expect(
			parseAllow(["GitHub.com", "api.example.com:443", "*.npmjs.org."]),
		).toEqual(["github.com", "api.example.com:443", "*.npmjs.org"]);
	});
	test("refuses an empty list, URLs, spaces, commas", () => {
		expect(parseAllow([])).toContain("empty");
		for (const bad of ["https://x.com", "a b", "a,b", "*", "x/y", ""])
			expect(parseAllow([bad])).toContain("is not a host");
	});
	test("proxyEnv points every proxy variable at the proxy", () => {
		const e = proxyEnv("10.89.0.2");
		expect(e.HTTPS_PROXY).toBe("http://10.89.0.2:3128");
		expect(e.http_proxy).toBe("http://10.89.0.2:3128");
		expect(e.NO_PROXY).toContain("localhost");
	});
});

// A target server on 127.0.0.1 and the proxy, run by bun and (if present) node.
const target = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: (req) => new Response(`hi ${new URL(req.url).pathname}`),
});
afterAll(() => target.stop(true));

async function startProxy(bin: string, allow: string) {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const p = Bun.spawn([bin, "-e", PROXY_JS], {
		env: { ...process.env, MM_PROXY_ALLOW: allow, MM_PROXY_PORT: String(port) },
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = p.stdout.getReader();
	let seen = "";
	while (!seen.includes(PROXY_READY)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`proxy ended: ${seen}`);
		seen += new TextDecoder().decode(value);
	}
	return { port, stop: () => p.kill() };
}

/** Send raw bytes, return everything the proxy sends back. */
function raw(port: number, send: string, after?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let got = "";
		const s = connect(port, "127.0.0.1", () => s.write(send));
		s.on("data", (d) => {
			got += d.toString();
			if (after && got.includes("200 Connection Established")) {
				s.write(after);
				after = undefined;
			}
		});
		s.on("end", () => resolve(got));
		s.on("error", reject);
		setTimeout(() => {
			s.destroy();
			resolve(got);
		}, 2000);
	});
}

const bins = ["bun", ...(Bun.which("node") ? ["node"] : [])];
for (const bin of bins)
	describe(`proxy under ${bin}`, () => {
		test("tunnels and forwards allowed hosts; refuses the rest", async () => {
			const proxy = await startProxy(bin, `127.0.0.1:${target.port},*.ok.test`);
			try {
				const t = target.port ?? 0;
				// CONNECT to an allowed host:port, then speak HTTP through the tunnel.
				const tunnel = await raw(
					proxy.port,
					`CONNECT 127.0.0.1:${t} HTTP/1.1\r\nHost: 127.0.0.1:${t}\r\n\r\n`,
					`GET /via-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
				);
				expect(tunnel).toContain("200 Connection Established");
				expect(tunnel).toContain("hi /via-tunnel");
				// Plain HTTP in absolute form.
				const plain = await raw(
					proxy.port,
					`GET http://127.0.0.1:${t}/plain?q=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
				);
				expect(plain).toContain("hi /plain");
				// Not listed: refused, also on another port of an allowed host.
				for (const bad of [
					"CONNECT example.com:443 HTTP/1.1\r\n\r\n",
					`CONNECT 127.0.0.1:${t + 1} HTTP/1.1\r\n\r\n`,
					"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
					"CONNECT ok.test:443 HTTP/1.1\r\n\r\n",
					"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
				]) {
					const r = await raw(proxy.port, bad);
					expect(r).toContain("403 Forbidden");
					expect(r).toContain("not in the network allow list");
				}
				// Allowed name that does not resolve: 502, not a hang.
				const gone = await raw(
					proxy.port,
					"CONNECT nowhere.ok.test:443 HTTP/1.1\r\n\r\n",
				);
				expect(gone).toContain("502 Bad Gateway");
			} finally {
				proxy.stop();
			}
		}, 20_000);
	});
