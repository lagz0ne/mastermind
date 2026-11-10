// Smoke check for the public NATS WebSocket (bead mm-210.15). No dependencies:
// it speaks the raw NATS protocol over Bun's WebSocket.
//
//   bun deploy/nats/smoke.ts wss://mastermind.vibea.dev/nats
//
// Pass: the server sends INFO, and a CONNECT without valid auth is refused.

export type Probe = {
	info: Record<string, unknown>;
	/** "PONG" when the server accepted the CONNECT, else the -ERR text. */
	reply: string;
};

/** Open a WebSocket, read INFO, send CONNECT (+ PING), return the first reply. */
export function probe(
	url: string,
	connect: Record<string, unknown> = {},
	timeoutMs = 10_000,
): Promise<Probe> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		let buf = "";
		let info: Record<string, unknown> | undefined;
		const done = (fn: () => void) => {
			clearTimeout(timer);
			ws.close();
			fn();
		};
		const timer = setTimeout(
			() => done(() => reject(new Error(`timeout after ${timeoutMs} ms`))),
			timeoutMs,
		);
		ws.onerror = () => done(() => reject(new Error(`websocket error: ${url}`)));
		ws.onclose = (e) =>
			done(() => reject(new Error(`closed before reply (code ${e.code})`)));
		ws.onmessage = (e) => {
			buf +=
				typeof e.data === "string"
					? e.data
					: new TextDecoder().decode(e.data as ArrayBuffer);
			for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (!info) {
					if (!line.startsWith("INFO ")) {
						return done(() => reject(new Error(`expected INFO, got ${line}`)));
					}
					info = JSON.parse(line.slice(5)) as Record<string, unknown>;
					const opts = { verbose: false, pedantic: false, ...connect };
					ws.send(`CONNECT ${JSON.stringify(opts)}\r\nPING\r\n`);
				} else if (line === "PONG" || line.startsWith("-ERR")) {
					const result = { info, reply: line };
					return done(() => resolve(result));
				}
			}
		};
	});
}

if (import.meta.main) {
	const url = Bun.argv[2];
	if (!url) {
		console.error("usage: bun deploy/nats/smoke.ts <ws(s)://host/path>");
		process.exit(2);
	}
	const { info, reply } = await probe(url);
	console.log(`INFO: server ${info.server_name} v${info.version}`);
	console.log(`CONNECT without auth: ${reply}`);
	if (reply === "PONG") {
		console.error("FAIL: the server accepted a connection without auth");
		process.exit(1);
	}
	console.log("OK: INFO received, unauthenticated connect refused");
}
