import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	networkPhases,
	PROXY_JS,
	PROXY_READY,
	parseAllow,
	proxyAllowLine,
	proxyEnv,
	repoHost,
	SETUP_REGISTRIES,
} from "../../src/box/proxy.ts";

describe("networkPhases", () => {
	test("open and none: one phase", () => {
		expect(networkPhases("open")).toBeNull();
		expect(networkPhases("none")).toBeNull();
		expect(networkPhases(undefined)).toBeNull();
	});
	test("allow list: setup gets the registries and the repo host, the agent only the list", () => {
		const p = networkPhases(
			{ allow: ["api.anthropic.com"] },
			"https://git.example.com:8443/acme/web.git",
		);
		expect(p?.agent).toEqual(["api.anthropic.com"]);
		expect(p?.setup).toContain("api.anthropic.com");
		expect(p?.setup).toContain("registry.npmjs.org");
		expect(p?.setup).toContain("git.example.com:8443");
		expect(p?.agent).not.toContain("registry.npmjs.org");
		// every preset entry is a valid allow entry
		expect(parseAllow([...SETUP_REGISTRIES])).toEqual([...SETUP_REGISTRIES]);
	});
	test("repoHost: http(s) only", () => {
		expect(repoHost("https://github.com/a/b.git")).toBe("github.com");
		expect(repoHost("git@github.com:a/b.git")).toBeNull();
		expect(repoHost("ssh://git@github.com/a/b.git")).toBeNull();
		expect(repoHost("")).toBeNull();
	});
});

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

const rulesDir = mkdtempSync(join(tmpdir(), "mm-proxy-rules-"));
afterAll(() => rmSync(rulesDir, { recursive: true, force: true }));
let rulesN = 0;

async function startProxy(bin: string, allow: string) {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const rules = join(rulesDir, `rules-${++rulesN}`);
	const lines: string[] = [];
	const p = Bun.spawn([bin, "-e", PROXY_JS], {
		env: {
			...process.env,
			MM_PROXY_ALLOW: allow,
			MM_PROXY_PORT: String(port),
			MM_PROXY_RULES: rules,
		},
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
	lines.push(seen);
	(async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			lines.push(new TextDecoder().decode(value));
		}
	})();
	/** Write rules generation `gen` like the driver does; wait for the ack. */
	const setAllow = async (gen: number, list: string) => {
		writeFileSync(`${rules}.new`, `${gen}\n${list}`);
		renameSync(`${rules}.new`, rules);
		const until = Date.now() + 5000;
		while (!lines.join("").includes(proxyAllowLine(gen))) {
			if (Date.now() > until) throw new Error(`no ack: ${lines.join("")}`);
			await Bun.sleep(20);
		}
		return lines.join("");
	};
	return { port, setAllow, stop: () => p.kill() };
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

		test("a new rules generation switches the list and closes tunnels it no longer allows", async () => {
			const t = target.port ?? 0;
			const proxy = await startProxy(bin, `127.0.0.1:${t}`);
			try {
				// A tunnel opened in the setup phase.
				const s = connect(proxy.port, "127.0.0.1");
				let got = "";
				let closed = false;
				s.on("data", (d) => {
					got += d.toString();
				});
				s.on("close", () => {
					closed = true;
				});
				s.on("error", () => {});
				s.write(`CONNECT 127.0.0.1:${t} HTTP/1.1\r\n\r\n`);
				const until = Date.now() + 3000;
				while (!got.includes("200 Connection Established")) {
					if (Date.now() > until) throw new Error(got);
					await Bun.sleep(20);
				}
				// Agent phase: only *.ok.test.
				const log = await proxy.setAllow(1, "*.ok.test");
				expect(log).toContain("mm-proxy allow 1: *.ok.test (closed 1)");
				const until2 = Date.now() + 3000;
				while (!closed && Date.now() < until2) await Bun.sleep(20);
				expect(closed).toBe(true);
				const r = await raw(
					proxy.port,
					`CONNECT 127.0.0.1:${t} HTTP/1.1\r\n\r\n`,
				);
				expect(r).toContain("403 Forbidden");
				// And back: generation 2 allows the target again.
				await proxy.setAllow(2, `127.0.0.1:${t}`);
				const ok = await raw(
					proxy.port,
					`GET http://127.0.0.1:${t}/again HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
				);
				expect(ok).toContain("hi /again");
			} finally {
				proxy.stop();
			}
		}, 20_000);
	});
