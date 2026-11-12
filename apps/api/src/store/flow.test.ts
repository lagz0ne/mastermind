// The whole flow on the NATS work store, wired as index.ts wires it
// (startNatsWork + boardRoutes + beadsRoutes + the dispatcher): create from
// the UI route -> routed by a KV rule -> a runner takes it -> reports ->
// completes -> timeline, with every step on the board's SSE stream.
// Needs a nats-server (NATS_TEST_URL, NATS_SERVER or nats-server on PATH).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, request, Store, subjects } from "@mastermind/bus";
import type {
	Ack,
	BeadDetail,
	BeadEvent,
	BoardSnapshot,
	NextReply,
	NextRequest,
} from "@mastermind/core";
import { natsAvailable, type TestNats, testNats } from "@mastermind/work/test";
import type { NatsConnection } from "@nats-io/nats-core";
import { beadsRoutes } from "../beads/routes.ts";
import { boardRoutes } from "../board/routes.ts";
import { CONFIG_BUCKET, ROUTING_KEY } from "../dispatch/nats.ts";
import { type RunningNatsWork, startNatsWork } from "./nats-work.ts";

const runner: NextRequest = {
	runner: {
		id: "laptop",
		account: "alice",
		serviceAccount: "alice-sa",
		providers: ["claude"],
		capabilities: [],
	},
};

describe.skipIf(!natsAvailable())("flow on the NATS work store", () => {
	let nats: TestNats;
	let mm: NatsConnection;
	let client: NatsConnection;
	let work: RunningNatsWork;
	let board: ReturnType<typeof boardRoutes>;
	const sse: { event: BeadEvent; at: number }[] = [];
	const abort = new AbortController();
	const k = Date.now().toString(36);

	beforeAll(async () => {
		nats = await testNats();
		mm = await connect({ servers: nats.url, name: "mm" });
		client = await connect({ servers: nats.url, name: "runner" });
		const config = await Store.open(mm, CONFIG_BUCKET);
		await config.put(ROUTING_KEY, {
			queues: [{ name: "flow", description: "", members: ["alice"] }],
			rules: [{ match: { type: "bug" }, queue: "flow" }],
		});
		work = startNatsWork({
			nats: { connection: Promise.resolve(mm) },
			store: {
				stream: `F_WORK_${k}`,
				subject: `f.work.${k}`,
				leaseBucket: `f_leases_${k}`,
			},
			log: () => {},
		});
		for (let i = 0; (await work.dispatchProbe()) !== "up"; i++) {
			if (i > 100) throw new Error("dispatcher did not start");
			await Bun.sleep(50);
		}
		expect(await work.probe()).toBe("up");
		board = boardRoutes(work.board, { leaseIntervalMs: 100 });
		const res = await board.routes["/api/events"](
			new Request("http://x/api/events?since=0", { signal: abort.signal }),
		);
		void (async () => {
			const decoder = new TextDecoder();
			let buf = "";
			for await (const chunk of res.body as ReadableStream<Uint8Array>) {
				buf += decoder.decode(chunk);
				let i = buf.indexOf("\n\n");
				for (; i >= 0; i = buf.indexOf("\n\n")) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const data = frame.match(/^event: bead\ndata: (.*)$/m)?.[1];
					if (data && frame.startsWith("id:"))
						sse.push({ event: JSON.parse(data), at: performance.now() });
				}
			}
		})().catch(() => {});
	});

	afterAll(async () => {
		abort.abort();
		board?.stop();
		await work?.stop();
		await Promise.all([mm?.drain(), client?.drain()]);
		nats?.stop();
	});

	const until = async (what: string, ok: () => boolean | Promise<boolean>) => {
		for (let i = 0; !(await ok()); i++) {
			if (i > 200) throw new Error(`timed out: ${what}`);
			await Bun.sleep(10);
		}
	};

	test("create -> routed -> taken -> report -> complete -> timeline", async () => {
		const beads = beadsRoutes(work.beads, {
			requireAccount: async () => "duke",
		});
		const post = (path: string, body: object) =>
			new Request(`http://x${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const t0 = performance.now();
		const created = await beads["/api/beads"].POST(
			post("/api/beads", { title: "fix the flow", type: "bug" }),
		);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		await until("create on SSE", () =>
			sse.some((s) => s.event.beadId === id && s.event.op === "create"),
		);
		const toBrowser = (sse.find((s) => s.event.beadId === id)?.at ?? 0) - t0;
		expect(toBrowser).toBeLessThan(1_000);

		// The dispatcher routes it by the KV rule (type bug -> queue flow).
		await until("routed", async () =>
			(await work.beads.get(id)).labels.includes("queue:flow"),
		);

		// The runner says it is ready (readiness gate, mm-210.59).
		client.publish(
			subjects.runnerStatus("alice", runner.runner.id),
			JSON.stringify({
				runner: runner.runner.id,
				readiness: {
					state: "ready",
					readyEnvironments: [],
					failedChecks: [],
					checkedAt: new Date().toISOString(),
				},
			}),
		);
		await client.flush();
		const { dispatch } = await request<NextRequest, NextReply>(
			client,
			subjects.next("alice", "flow"),
			runner,
			{ timeout: 5_000 },
		);
		expect(dispatch?.bead.id).toBe(id);
		const actor = dispatch?.actor as string;
		const verb = (v: "heartbeat" | "report" | "complete", body: object) =>
			request<object, Ack>(client, subjects.bead("alice", id, v), body, {
				timeout: 5_000,
			});
		await verb("heartbeat", { actor });
		await verb("report", { actor, message: "half way" });
		expect(await verb("complete", { actor, summary: "fixed" })).toEqual({
			ok: true,
		});

		const detail = (await (
			await beads["/api/beads/:id"].GET(
				Object.assign(new Request(`http://x/api/beads/${id}`), {
					params: { id },
				}),
			)
		).json()) as BeadDetail;
		expect(detail.bead.status).toBe("closed");
		const kinds = detail.timeline.map((e) => e.kind);
		expect(kinds).toEqual([
			"created",
			"routed",
			"claimed",
			"report",
			"completed",
		]);
		expect(detail.timeline.find((e) => e.kind === "report")?.text).toBe(
			"half way",
		);

		const snapshot = (await (
			await board.routes["/api/board"](new Request("http://x/api/board"))
		).json()) as BoardSnapshot;
		expect(snapshot.beads.find((b) => b.id === id)?.status).toBe("closed");
		await until("close on SSE", () =>
			sse.some((s) => s.event.beadId === id && s.event.op === "close"),
		);
		const seqs = sse.map((s) => s.event.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(seqs.at(-1)).toBe(snapshot.seq);
	}, 20_000);
});
