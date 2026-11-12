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
 *
 * Two network phases (mm-210.63; prior art: Codex cloud, internet on for
 * setup and off or allow-listed for the agent; Copilot agent firewall): the
 * box starts with the setup list ({@link networkPhases}: the allow list plus
 * the package registries and the repo host). Before the agent starts, the
 * driver writes the agent list into {@link PROXY_RULES} in the proxy box; the
 * proxy reloads it, closes the tunnels that the new list does not allow and
 * logs `mm-proxy allow <generation>`. No restart, the address stays.
 *
 * The model route (mm-210.70; prior art: Claude Code on the web, "the key
 * itself stays outside the VM"; Codex cloud, a placeholder in the program and
 * the real value put in by the proxy): the box gets ANTHROPIC_BASE_URL =
 * http://<proxy>:{@link MODEL_PORT}/<random path> and a placeholder token. The
 * proxy box forwards that path to {@link MODEL_UPSTREAM} and replaces the auth
 * header with the runner's credential, which it reads from
 * {@link MODEL_AUTH_FILE} in the proxy box. No TLS interception. Only that one
 * upstream, and only for a request that knows the random path.
 */

/** Port of the proxy inside the proxy box. */
export const PROXY_PORT = 3128;

/** First line the proxy logs when it is ready. */
export const PROXY_READY = "mm-proxy listening";

/** Rules file in the proxy box: `<generation>\n<entry,entry,...>`. Wins over MM_PROXY_ALLOW. */
export const PROXY_RULES = "/tmp/mm-proxy-allow";

/** The log line of the proxy after it applied rules generation `gen`. */
export function proxyAllowLine(gen: number): string {
	return `mm-proxy allow ${gen}:`;
}

/**
 * Hosts setup may reach on top of the allow list: the common package
 * registries, OS package mirrors, GitHub (source and release downloads) and
 * the container registries. Like Codex's "common dependencies" preset.
 */
export const SETUP_REGISTRIES: readonly string[] = [
	// JavaScript
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"nodejs.org",
	// Python
	"pypi.org",
	"files.pythonhosted.org",
	// Rust
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"static.rust-lang.org",
	// Go
	"proxy.golang.org",
	"sum.golang.org",
	// Ruby, Java
	"rubygems.org",
	"index.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"plugins.gradle.org",
	"services.gradle.org",
	// OS packages
	"deb.debian.org",
	"security.debian.org",
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"dl-cdn.alpinelinux.org",
	// GitHub: clone, archives, release assets
	"github.com",
	"codeload.github.com",
	"*.githubusercontent.com",
	// Container registries
	"ghcr.io",
	"registry-1.docker.io",
	"auth.docker.io",
	"production.cloudflare.docker.com",
];

/** Host of an http(s) git remote; null for ssh and others (they never use the proxy). */
export function repoHost(repo: string | undefined): string | null {
	if (!repo) return null;
	try {
		const u = new URL(repo);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return u.port ? `${u.hostname}:${u.port}` : u.hostname;
	} catch {
		return null;
	}
}

/**
 * The allow lists of the two phases of a box with an allow list: setup
 * (clone, devcontainer lifecycle commands, setup, check) gets the list plus
 * {@link SETUP_REGISTRIES} plus the repo host; the agent gets only the list.
 * `open` (and `none`): one phase, no switch.
 */
export function networkPhases(
	network: "open" | "none" | { allow: string[] } | undefined,
	repo?: string,
): { setup: string[]; agent: string[] } | null {
	if (!network || typeof network !== "object") return null;
	const host = repoHost(repo);
	const setup = [
		...new Set([
			...network.allow,
			...SETUP_REGISTRIES,
			...(host ? [host] : []),
		]),
	];
	return { setup, agent: [...network.allow] };
}

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

/**
 * The environment of the task box that sends its traffic to the proxy.
 * `direct`: more hosts that skip it (the model route of the proxy box itself).
 */
export function proxyEnv(
	ip: string,
	direct: readonly string[] = [],
): Record<string, string> {
	const url = `http://${ip}:${PROXY_PORT}`;
	const no = [NO_PROXY, ...direct].join(",");
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		NO_PROXY: no,
		no_proxy: no,
		// Node 24 fetch only uses HTTP(S)_PROXY with this.
		NODE_USE_ENV_PROXY: "1",
	};
}

/** Port of the model route in the proxy box. */
export const MODEL_PORT = 3129;

/** The line the proxy logs when the model route listens. */
export const MODEL_READY = "mm-proxy model on";

/** Where the model route sends requests. */
export const MODEL_UPSTREAM = "https://api.anthropic.com";

/** The credential of the model route, in the proxy box only: `{header, value}` JSON. */
export const MODEL_AUTH_FILE = "/tmp/mm-model-auth.json";

/** What the box holds in place of the model credential. */
export const MODEL_PLACEHOLDER = "mastermind-model-proxy-placeholder";

/** The model credential secrets, in order of use (the onboarding stores one of them). */
export const MODEL_SECRETS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
] as const;

/**
 * The model credential of a box: the secret's name (the box gets that name
 * with {@link MODEL_PLACEHOLDER}) and the header the proxy sets upstream.
 */
export type ModelAuth = {
	secret: (typeof MODEL_SECRETS)[number];
	header: "authorization" | "x-api-key";
	value: string;
};

/**
 * Split the model credential (all {@link MODEL_SECRETS}; the first one given
 * is used) from the rest of the box secrets. An OAuth token (`claude
 * setup-token`) goes upstream as `Authorization: Bearer`, an API key as
 * `x-api-key`: the same header Claude Code sends with the placeholder.
 */
export function splitModelSecrets(secrets: Record<string, string>): {
	model: ModelAuth | null;
	box: Record<string, string>;
} {
	const box: Record<string, string> = {};
	for (const [k, v] of Object.entries(secrets))
		if (!(MODEL_SECRETS as readonly string[]).includes(k)) box[k] = v;
	const secret = MODEL_SECRETS.find((n) => secrets[n]);
	if (!secret) return { model: null, box };
	const value = secrets[secret] ?? "";
	return {
		model:
			secret === "CLAUDE_CODE_OAUTH_TOKEN"
				? { secret, header: "authorization", value: `Bearer ${value}` }
				: { secret, header: "x-api-key", value },
		box,
	};
}

/** A fresh random path of the model route of one box. */
export function modelPath(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString(
		"hex",
	);
}

/** The environment of a box whose model credential stays in its proxy box. */
export function modelEnv(
	ip: string,
	path: string,
	model: Pick<ModelAuth, "secret">,
): Record<string, string> {
	return {
		ANTHROPIC_BASE_URL: `http://${ip}:${MODEL_PORT}/${path}`,
		[model.secret]: MODEL_PLACEHOLDER,
	};
}

/** The proxy box environment of the model route (no secret value). */
export function modelProxyEnv(path: string): Record<string, string> {
	return {
		MM_MODEL_PATH: path,
		MM_MODEL_UPSTREAM: MODEL_UPSTREAM,
		MM_MODEL_AUTH_FILE: MODEL_AUTH_FILE,
	};
}

/**
 * The proxy program. Env: MM_PROXY_ALLOW (comma separated, from
 * {@link parseAllow}), MM_PROXY_PORT. Logs every refusal. With MM_MODEL_PATH
 * also the model route on MM_MODEL_PORT (see {@link modelProxyEnv}): it logs
 * method, path and status of failed calls, never a header value.
 */
export const PROXY_JS = `
const net = require("node:net");
const fs = require("node:fs");
const list = (t) => t.split(",").map((s) => s.trim()).filter(Boolean);
let allow = list(process.env.MM_PROXY_ALLOW || "");
const port = Number(process.env.MM_PROXY_PORT || ${PROXY_PORT});
const rulesFile = process.env.MM_PROXY_RULES || "${PROXY_RULES}";
const live = new Set();
let rulesText = "";
function reload() {
  let t;
  try { t = fs.readFileSync(rulesFile, "utf8"); } catch { return; }
  if (t === rulesText) return;
  const nl = t.indexOf("\\n");
  if (nl < 0) return;
  rulesText = t;
  allow = list(t.slice(nl + 1));
  let closed = 0;
  for (const x of live) if (!allowed(x.host, x.p)) { x.c.destroy(); x.up.destroy(); live.delete(x); closed++; }
  console.log("mm-proxy allow " + t.slice(0, nl).trim() + ": " + allow.join(",") + " (closed " + closed + ")");
}
setInterval(reload, 100);
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
const srv = net.createServer((c) => {
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
    reload();
    if (!host || !allowed(host, p)) {
      console.log("mm-proxy: refused " + (host ? host + ":" + p : JSON.stringify(line.slice(0, 200))));
      refuse(c, "403 Forbidden", "mastermind: " + (host || "this request") + " is not in the network allow list of this environment\\n");
      return;
    }
    let open = false;
    const up = net.connect(p, host, () => {
      if (!allowed(host, p)) { up.destroy(); refuse(c, "403 Forbidden", "mastermind: " + host + " is not in the network allow list of this environment\\n"); return; }
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
    const x = { c, up, host, p };
    live.add(x);
    c.on("close", () => { live.delete(x); up.destroy(); });
    up.on("close", () => live.delete(x));
  };
  c.on("data", onData);
}).listen(port, "0.0.0.0", () => console.log("${PROXY_READY} on " + srv.address().port + " for " + allow.join(",")));
if (process.env.MM_MODEL_PATH) {
  const http = require("node:http");
  const https = require("node:https");
  const prefix = "/" + process.env.MM_MODEL_PATH;
  const upstream = new URL(process.env.MM_MODEL_UPSTREAM || "${MODEL_UPSTREAM}");
  const client = upstream.protocol === "http:" ? http : https;
  const authFile = process.env.MM_MODEL_AUTH_FILE || "${MODEL_AUTH_FILE}";
  const mport = Number(process.env.MM_MODEL_PORT || ${MODEL_PORT});
  const hop = ["host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "upgrade", "authorization", "x-api-key"];
  let auth = null;
  const fail = (res, status, text) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end("mastermind model proxy: " + text + "\\n");
  };
  const msrv = http.createServer((req, res) => {
    const url = req.url || "/";
    const path = url.split("?")[0];
    if (path !== prefix && !path.startsWith(prefix + "/")) {
      console.log("mm-proxy model: refused " + req.method + " (unknown path)");
      return fail(res, 404, "unknown path");
    }
    const rest = url.slice(prefix.length) || "/";
    const shown = req.method + " " + rest.split("?")[0];
    try { auth = auth || JSON.parse(fs.readFileSync(authFile, "utf8")); }
    catch { console.log("mm-proxy model: no credential for " + shown); return fail(res, 503, "no model credential"); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!hop.includes(k)) headers[k] = v;
    headers[auth.header] = auth.value;
    const up = client.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined,
      method: req.method, path: (upstream.pathname.replace(/\\/$/, "") + rest) || "/", headers,
    }, (ur) => {
      if ((ur.statusCode || 0) >= 400) console.log("mm-proxy model: " + shown + " " + ur.statusCode);
      const h = { ...ur.headers };
      delete h.connection; delete h["keep-alive"];
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    });
    up.on("error", (e) => { console.log("mm-proxy model: " + shown + ": " + e.message); fail(res, 502, e.message); });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }).listen(mport, "0.0.0.0", () => console.log("${MODEL_READY} " + msrv.address().port + " to " + upstream.host));
}
`;

/** Shell entrypoint of the proxy box: node, else bun, else a clear error. */
export const PROXY_SH =
	'if command -v node >/dev/null 2>&1; then exec node -e "$MM_PROXY_JS"; ' +
	'elif command -v bun >/dev/null 2>&1; then exec bun -e "$MM_PROXY_JS"; ' +
	'else echo "mm-proxy: the proxy image has neither node nor bun (set MM_BOX_PROXY_IMAGE)" >&2; exit 127; fi';
