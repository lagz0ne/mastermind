// Direct offers over a real nats-server (mm-210.32): a stand-in Mastermind
// sends an offer the way apps/api does (request with a reply subject under
// the account), the runner's serveOffers answers with a request, and
// Mastermind replies with the dispatch. Opt in:
//   NATS_SERVER=/path/to/nats-server bun test test/offer.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, decode, encode, subjects } from "@mastermind/bus";
import type { DirectOffer, OfferAnswer, RunnerInfo } from "@mastermind/core";
import type { NatsConnection } from "@nats-io/nats-core";
import { defaultSettings } from "../src/config.ts";
import { serveOffers } from "../src/offer.ts";
import { Runner } from "../src/runner.ts";
import { dispatch, FakeLauncher, FakeMastermind, until } from "./fakes.ts";

const bin = process.env.NATS_SERVER ?? Bun.which("nats-server");

describe.skipIf(!bin)("direct offers over NATS", () => {
	const dir = mkdtempSync(join(tmpdir(), "mm-runner-offer-"));
	const base = 20_000 + Math.floor(Math.random() * 20_000);
	let server: ReturnType<typeof Bun.spawn> | undefined;
	let mm: NatsConnection;
	let rc: NatsConnection;
	let runner: Runner;
	const client = new FakeMastermind();
	const launcher = new FakeLauncher({ status: "done", summary: "ok" });
	const info: RunnerInfo = {
		id: "laptop",
		account: "bob",
		serviceAccount: "bob-sa",
		capabilities: [],
	};

	beforeAll(async () => {
		await Bun.write(
			join(dir, "nats.conf"),
			`listen: 127.0.0.1:${base}\nhttp: 127.0.0.1:${base + 1}\nwebsocket { listen: "127.0.0.1:${base + 2}", no_tls: true }\n`,
		);
		// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
		server = Bun.spawn([bin!, "-c", join(dir, "nats.conf")], {
			stdout: "ignore",
			stderr: "ignore",
		});
		for (let i = 0; i < 50; i++) {
			const r = await fetch(`http://127.0.0.1:${base + 1}/healthz`).catch(
				() => undefined,
			);
			if (r?.ok) break;
			await Bun.sleep(100);
		}
		const url = `ws://127.0.0.1:${base + 2}`;
		mm = await connect({ servers: url, name: "fake-mastermind" });
		rc = await connect({ servers: url, name: "runner" });
		runner = new Runner({
			client,
			launcher,
			settings: {
				...defaultSettings("laptop"),
				queues: ["q"],
				workdir: "/tmp",
				agent: { provider: "claude" },
				capacity: 1,
			},
			check: async () => ({ ok: true, cwd: "/work", env: {} }),
			idleMs: 10,
			heartbeatMs: 50,
		});
		runner.start();
		serveOffers(rc, { runner: info, taker: runner });
		await rc.flush();
	}, 20_000);

	afterAll(async () => {
		await runner?.stop();
		await Promise.all([mm, rc].map((nc) => nc?.drain()));
		server?.kill();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Like apps/api natsOffer: offer, read the answer, reply with `result`. */
	async function offer(id: string, accept: (a: OfferAnswer) => unknown) {
		const {
			actor: _a,
			lease: _l,
			...d
		} = dispatch(id, {
			queue: "to:bob/laptop",
		});
		const o: DirectOffer = { ...d, address: "bob/laptop" };
		const msg = await mm.request(
			subjects.runnerOffer("bob", "laptop"),
			encode(o),
			{
				timeout: 5_000,
				noMux: true,
				reply: subjects.runnerOfferReply("bob", "laptop", `n${id}`),
			},
		);
		const answer = decode<OfferAnswer>(msg.data);
		msg.respond(encode({ result: accept(answer) }));
		return answer;
	}

	test("accept: the runner runs the dispatch that comes back in the same exchange", async () => {
		const answer = await offer("mm-1", () => ({
			dispatch: dispatch("mm-1", {
				queue: "to:bob/laptop",
				actor: "bob/laptop",
			}),
		}));
		expect(answer).toEqual({ accept: true, runner: info });
		await until(() => client.verbs("complete").length === 1);
		expect(launcher.specs.map((s) => s.beadId)).toEqual(["mm-1"]);
	});
});
