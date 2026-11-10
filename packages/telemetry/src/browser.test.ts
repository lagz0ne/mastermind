import { describe, expect, test } from "bun:test";
import {
	type BrowserEvent,
	createQueue,
	type RouterLike,
	trackRouter,
} from "./browser.ts";

describe("createQueue", () => {
	test("flush sends batches of at most 50 events and empties the queue", () => {
		const sent: { body: string; beacon: boolean }[] = [];
		const q = createQueue({
			send: (body, beacon) => sent.push({ body, beacon }),
		});
		for (let i = 0; i < 120; i++)
			q.push({ type: "route", path: `/p${i}`, ms: i });
		q.flush(true);
		expect(sent.map((s) => JSON.parse(s.body).events.length)).toEqual([
			50, 50, 20,
		]);
		expect(sent.every((s) => s.beacon)).toBe(true);
		expect(q.size).toBe(0);
		q.flush();
		expect(sent).toHaveLength(3);
	});

	test("errors are capped per page", () => {
		const q = createQueue({ send: () => {}, maxErrors: 2 });
		for (let i = 0; i < 5; i++)
			q.push({ type: "error", message: `e${i}`, path: "/" });
		expect(q.size).toBe(2);
	});
});

describe("trackRouter", () => {
	test("pushes navigation start to resolved per path", () => {
		const listeners: Record<
			string,
			(e: { toLocation: { pathname: string } }) => void
		> = {};
		const router: RouterLike = {
			subscribe(event, fn) {
				listeners[event] = fn;
				return () => delete listeners[event];
			},
		};
		const events: BrowserEvent[] = [];
		let clock = 100;
		const off = trackRouter(
			router,
			(e) => events.push(e),
			() => clock,
		);
		const loc = { toLocation: { pathname: "/board" } };
		listeners.onResolved?.(loc); // initial resolve without a start: ignored
		listeners.onBeforeNavigate?.(loc);
		clock = 142;
		listeners.onResolved?.(loc);
		expect(events).toEqual([{ type: "route", path: "/board", ms: 42 }]);
		off();
		expect(Object.keys(listeners)).toEqual([]);
	});
});
