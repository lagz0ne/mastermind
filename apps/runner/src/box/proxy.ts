/**
 * The egress proxy of a box with a network allow list.
 *
 * The task box sits on an internal network with no route out. A second box
 * (the proxy box) is on that network and on the default network, and runs
 * {@link PROXY_JS}: an HTTP proxy (CONNECT for HTTPS, absolute-form for plain
 * HTTP) that only connects to the allowed hosts. The task box gets
 * HTTP(S)_PROXY. Anything that ignores the proxy has no network at all.
 *
 * Allow entries (see EnvironmentNetwork): `host` (any port), `host:port`,
 * `*.host` (subdomains only), `*.host:port`. Plain JavaScript for `node -e` or
 * `bun -e`, so it runs in any image that has one of them.
 */

/** Port of the proxy inside the proxy box. */
export const PROXY_PORT = 3128;

/** First line the proxy logs when it is ready. */
export const PROXY_READY = "mm-proxy listening";

/** Hosts that never go through the proxy. */
export const NO_PROXY = "localhost,127.0.0.1,::1";

const ENTRY =
	/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** Normalised allow entries; a BoxError-worthy message for a bad one. */
export function parseAllow(allow: readonly string[]): string[] | string {
	const out: string[] = [];
	for (const raw of allow) {
		const a = String(raw).trim().toLowerCase().replace(/\.$/, "");
		if (!ENTRY.test(a))
			return `network allow entry ${JSON.stringify(raw)} is not a host, host:port or *.host`;
		out.push(a);
	}
	if (out.length === 0)
		return "network allow list is empty (use none for no network)";
	return out;
}

/** The environment of the task box that sends its traffic to the proxy. */
export function proxyEnv(ip: string): Record<string, string> {
	const url = `http://${ip}:${PROXY_PORT}`;
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		NO_PROXY,
		no_proxy: NO_PROXY,
		// Node 24 fetch only uses HTTP(S)_PROXY with this.
		NODE_USE_ENV_PROXY: "1",
	};
}

/**
 * The proxy program. Env: MM_PROXY_ALLOW (comma separated, from
 * {@link parseAllow}), MM_PROXY_PORT. Logs every refusal.
 */
export const PROXY_JS = `
const net = require("node:net");
const allow = (process.env.MM_PROXY_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
const port = Number(process.env.MM_PROXY_PORT || ${PROXY_PORT});
function allowed(host, p) {
  host = host.toLowerCase().replace(/\\.$/, "");
  return allow.some((a) => {
    const m = /^(.*):(\\d+)$/.exec(a);
    const h = m ? m[1] : a;
    if (m && Number(m[2]) !== p) return false;
    return h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h;
  });
}
function refuse(c, status, text) {
  c.end("HTTP/1.1 " + status + "\\r\\ncontent-type: text/plain\\r\\nconnection: close\\r\\ncontent-length: " + Buffer.byteLength(text) + "\\r\\n\\r\\n" + text);
}
net.createServer((c) => {
  c.on("error", () => {});
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end < 0) { if (buf.length > 65536) c.destroy(); return; }
    c.off("data", onData);
    c.pause();
    const head = buf.subarray(0, end + 4).toString("latin1");
    const rest = buf.subarray(end + 4);
    const line = head.slice(0, head.indexOf("\\r\\n"));
    const [method, target, version] = line.split(" ");
    let host = "", p = 0, first = null;
    if (method === "CONNECT") {
      const m = /^\\[?([^\\]]*?)\\]?:(\\d+)$/.exec(target || "");
      if (m) { host = m[1]; p = Number(m[2]); }
    } else {
      try {
        const u = new URL(target);
        if (u.protocol === "http:") {
          host = u.hostname.replace(/^\\[|\\]$/g, "");
          p = Number(u.port || 80);
          first = method + " " + u.pathname + u.search + " " + version + head.slice(line.length);
        }
      } catch {}
    }
    if (!host || !allowed(host, p)) {
      console.log("mm-proxy: refused " + (host ? host + ":" + p : JSON.stringify(line.slice(0, 200))));
      refuse(c, "403 Forbidden", "mastermind: " + (host || "this request") + " is not in the network allow list of this environment\\n");
      return;
    }
    let open = false;
    const up = net.connect(p, host, () => {
      open = true;
      if (first === null) c.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
      else up.write(first);
      if (rest.length) up.write(rest);
      up.pipe(c);
      c.pipe(up);
      c.resume();
    });
    up.on("error", (e) => {
      if (open) c.destroy();
      else refuse(c, "502 Bad Gateway", "mastermind proxy: " + host + ":" + p + ": " + e.message + "\\n");
    });
    c.on("close", () => up.destroy());
  };
  c.on("data", onData);
}).listen(port, "0.0.0.0", () => console.log("${PROXY_READY} on " + port + " for " + allow.join(",")));
`;

/** Shell entrypoint of the proxy box: node, else bun, else a clear error. */
export const PROXY_SH =
	'if command -v node >/dev/null 2>&1; then exec node -e "$MM_PROXY_JS"; ' +
	'elif command -v bun >/dev/null 2>&1; then exec bun -e "$MM_PROXY_JS"; ' +
	'else echo "mm-proxy: the proxy image has neither node nor bun (set MM_BOX_PROXY_IMAGE)" >&2; exit 127; fi';
