/**
 * Runs only against a real nats-server (JetStream + WebSocket), for example:
 *
 *   NATS_TEST_URL=ws://127.0.0.1:47424 bun test
 *
 * CI has no server, so this whole file is skipped there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NatsConnection, Status } from "@nats-io/nats-core";
import { BusError } from "./codec.ts";
import { connect } from "./connect.ts";
import { publish, request, serve, subscribe } from "./rpc.ts";
import { Store } from "./store.ts";
import { parseSubject, patterns, SERVICE_QUEUE, subjects } from "./subjects.ts";

const url = process.env.NATS_TEST_URL;
const run = Date.now().toString(36);

describe.skipIf(!url)("against nats-server", () => {
	let mm: NatsConnection;
	let runner: NatsConnection;
	const statuses: Status[] = [];

	beforeAll(async () => {
		mm = await connect({
			servers: url as string,
			name: "bus-test-mm",
			onStatus: (s) => statuses.push(s),
		});
		runner = await connect({ servers: url as string, name: "bus-test-runner" });
	});
	afterAll(async () => {
		await Promise.all([mm?.drain(), runner?.drain()]);
	});

	test("typed request/reply through one queue group", async () => {
		const served = [0, 0];
		const subs = [0, 1].map((i) =>
			serve<{ n: number }, { user: string; queue: string; double: number }>(
				mm,
				patterns.next,
				SERVICE_QUEUE,
				(req, msg) => {
					served[i] = (served[i] ?? 0) + 1;
					const s = parseSubject(msg.subject);
					if (s?.kind !== "next")
						throw new BusError("bad_request", "not a next subject");
					return { user: s.user, queue: s.queue, double: req.n * 2 };
				},
			),
		);
		await mm.flush();
		for (let n = 0; n < 20; n++) {
			const res = await request<
				{ n: number },
				{ user: string; queue: string; double: number }
			>(runner, subjects.next("alice", "backend"), { n });
			expect(res).toEqual({ user: "alice", queue: "backend", double: n * 2 });
		}
		expect((served[0] ?? 0) + (served[1] ?? 0)).toBe(20);
		for (const s of subs) s.unsubscribe();
	});

	test("handler errors come back typed; unknown errors are hidden", async () => {
		const errs: unknown[] = [];
		const sub = serve<unknown, never>(
			mm,
			patterns.bead("complete"),
			SERVICE_QUEUE,
			(_req, msg) => {
				const s = parseSubject(msg.subject);
				if (s?.kind === "bead" && s.bead === "mm-1.2")
					throw new BusError("conflict", "lease lost");
				throw new Error("secret detail");
			},
			{ onError: (e) => errs.push(e) },
		);
		await mm.flush();
		await expect(
			request(runner, subjects.bead("alice", "mm-1.2", "complete"), {}),
		).rejects.toMatchObject({
			code: "conflict",
			message: "lease lost",
		});
		await expect(
			request(runner, subjects.bead("alice", "mm-9", "complete"), {}),
		).rejects.toMatchObject({
			code: "internal",
			message: "internal error",
		});
		expect(errs).toHaveLength(1);
		sub.unsubscribe();
	});

	test("bad JSON is bad_request; nobody serving is unavailable; slow is timeout", async () => {
		const sub = serve(mm, patterns.bead("report"), SERVICE_QUEUE, async () => {
			await Bun.sleep(300);
			return { ok: true };
		});
		await mm.flush();
		const raw = await runner.request(
			subjects.bead("a", "b", "report"),
			"{nope",
			{ timeout: 2000 },
		);
		expect(raw.json()).toEqual({
			error: { code: "bad_request", message: "payload is not JSON" },
		});
		await expect(
			request(runner, subjects.bead("a", "b", "report"), {}, { timeout: 50 }),
		).rejects.toMatchObject({
			code: "timeout",
		});
		sub.unsubscribe();
		await mm.flush();
		await expect(
			request(runner, subjects.next("nobody", "here"), {}),
		).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	test("publish/subscribe on the event subjects", async () => {
		const got: string[] = [];
		const a = subscribe<{ beadId: string }>(
			runner,
			subjects.ready("backend"),
			(e) => {
				got.push(`ready:${e.beadId}`);
			},
		);
		const b = subscribe<{ op: string }>(
			runner,
			patterns.beadEvents,
			(e, msg) => {
				const s = parseSubject(msg.subject);
				got.push(`event:${s?.kind === "beadEvent" ? s.bead : "?"}:${e.op}`);
			},
		);
		await runner.flush();
		publish(mm, subjects.ready("backend"), {
			queue: "backend",
			beadId: "mm-2",
			at: new Date().toISOString(),
		});
		publish(mm, subjects.beadEvent("mm-210.14"), { op: "close" });
		await mm.flush();
		await Bun.sleep(50);
		expect(got.sort()).toEqual(["event:mm-210.14:close", "ready:mm-2"]);
		a.unsubscribe();
		b.unsubscribe();
	});

	test("Store: create, get, CAS update, put, delete, list", async () => {
		type User = { name: string; queues: string[] };
		const users = await Store.open<User>(mm, `mm_test_users_${run}`, {
			history: 5,
		});
		const r1 = await users.create("alice", {
			name: "Alice",
			queues: ["backend"],
		});
		await expect(
			users.create("alice", { name: "x", queues: [] }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await users.get("alice")).toEqual({
			key: "alice",
			value: { name: "Alice", queues: ["backend"] },
			revision: r1,
		});

		const r2 = await users.update(
			"alice",
			{ name: "Alice", queues: ["backend", "web"] },
			r1,
		);
		expect(r2).toBeGreaterThan(r1);
		await expect(
			users.update("alice", { name: "stale", queues: [] }, r1),
		).rejects.toMatchObject({
			code: "conflict",
		});
		await users.put("bob", { name: "Bob", queues: ["web"] });
		expect((await users.list()).sort()).toEqual(["alice", "bob"]);

		await expect(users.delete("bob", r1)).rejects.toMatchObject({
			code: "conflict",
		});
		await users.delete("bob");
		expect(await users.get("bob")).toBeNull();
		expect(await users.list()).toEqual(["alice"]);
		// a deleted key can be created again
		await users.create("bob", { name: "Bob 2", queues: [] });
		expect((await users.get("bob"))?.value.name).toBe("Bob 2");
		expect(await users.get("nobody")).toBeNull();
	});

	test("Store: consume is single use under a race", async () => {
		const tokens = await Store.open<{ user: string }>(
			mm,
			`mm_test_tokens_${run}`,
		);
		await tokens.create("tok_abc", { user: "alice" });
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map(() => tokens.consume("tok_abc")),
		);
		expect(results.filter((r) => r !== null)).toEqual([{ user: "alice" }]);
		expect(await tokens.consume("tok_abc")).toBeNull();
		expect(await tokens.consume("never")).toBeNull();
	});

	test("Store: watch sees current values, then changes", async () => {
		const runners = await Store.open<{ v: number }>(
			mm,
			`mm_test_runners_${run}`,
		);
		await runners.put("alice.laptop", { v: 1 });
		const w = await runners.watch("alice.*");
		const seen: string[] = [];
		const done = (async () => {
			for await (const e of w) {
				seen.push(
					e.op === "put" ? `${e.key}=${e.value.v}` : `${e.key} deleted`,
				);
				if (seen.length === 3) break;
			}
		})();
		await runners.put("alice.laptop", { v: 2 });
		await runners.put("bob.laptop", { v: 9 });
		await runners.delete("alice.laptop");
		await done;
		w.stop();
		expect(seen).toEqual([
			"alice.laptop=1",
			"alice.laptop=2",
			"alice.laptop deleted",
		]);
	});

	test("Store: bucket TTL expires keys", async () => {
		const sessions = await Store.open<{ s: number }>(
			mm,
			`mm_test_sessions_${run}`,
			{ ttlMs: 1000 },
		);
		await sessions.create("s1", { s: 1 });
		expect(await sessions.get("s1")).not.toBeNull();
		await Bun.sleep(1600);
		expect(await sessions.get("s1")).toBeNull();
	});
});
