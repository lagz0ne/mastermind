import { describe, expect, test } from "bun:test";
import type { BeadEvent } from "@mastermind/core";
import { type EventSources, eventsPage, eventsStream } from "./events.ts";
import { LogRing } from "./log-ring.ts";

const ev = (seq: number, op = "create"): BeadEvent => ({
	seq,
	at: `t${seq}`,
	op,
	beadId: `mm-${seq}`,
	actor: "duke",
	bead: {
		id: `mm-${seq}`,
		title: "x",
		status: "open",
		priority: 2,
		type: "task",
		labels: ["queue:build"],
		blocked: false,
		createdAt: "t",
		updatedAt: "t",
	},
});

function runner(online: boolean) {
	return {
		account: "duke",
		runner: "laptop",
		serviceAccount: "s1",
		queues: ["build"],
		capabilities: [],
		providers: [],
		capacity: 1,
		version: "v1",
		running: [],
		lastSeenAt: "t",
		online,
		diagnostics: null,
	} as never;
}

describe("debug events", () => {
	test("page: work after since, runners, errors", async () => {
		const errors = new LogRing(10);
		errors.push("boom mms_a_b_c");
		const page = await eventsPage(
			{
				journalSince: async (s) => [ev(1), ev(2)].filter((e) => e.seq > s),
				runners: { list: () => [runner(true)], subscribe: () => () => {} },
				errors,
			},
			1,
		);
		expect(page.next).toBe(2);
		expect(page.work).toEqual([
			{
				seq: 2,
				at: "t2",
				op: "create",
				item: "mm-2",
				actor: "duke",
				status: "open",
				assignee: null,
				queue: "build",
				comment: undefined,
			},
		]);
		expect(page.runners[0]?.runner).toBe("duke/laptop");
		expect(page.errors[0]?.line).toBe("boom mms_[redacted]");
	});

	test("follow: backlog, then live work, a runner going offline and back, an error", async () => {
		let hubListener: (e: BeadEvent) => void = () => {};
		let regListener: () => void = () => {};
		let online = true;
		const errors = new LogRing(10);
		const src: EventSources = {
			journalSince: async (s) => [ev(1), ev(2)].filter((e) => e.seq > s),
			hub: () => ({
				subscribe(l) {
					hubListener = l;
					return { position: Promise.resolve(2), unsubscribe() {} };
				},
			}),
			runners: {
				list: () => [runner(online)],
				subscribe(l) {
					regListener = l;
					return () => {};
				},
			},
			errors,
			runnerCheckMs: 60_000,
		};
		const abort = new AbortController();
		const res = eventsStream(src, 0, abort.signal);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let text = "";
		const readUntil = async (needle: string) => {
			while (!text.includes(needle)) {
				const { value, done } = await reader.read();
				if (done) break;
				text += new TextDecoder().decode(value);
			}
		};
		await readUntil('"seq":2');
		hubListener(ev(2)); // duplicate: dropped
		hubListener(ev(3));
		await readUntil('"seq":3');
		online = false;
		regListener();
		await readUntil('"online":false');
		online = true;
		regListener();
		errors.push("work: nats down");
		await readUntil("nats down");
		abort.abort();
		const events = text.match(/^event: \w+/gm);
		expect(events).toEqual([
			"event: runner",
			"event: work",
			"event: work",
			"event: work",
			"event: runner",
			"event: runner",
			"event: error",
		]);
		expect(text.match(/"seq":2/g)).toHaveLength(1);
	});
});
