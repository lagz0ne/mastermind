// In-memory Mastermind and agent launcher for runner tests.
import { BusError } from "@mastermind/bus";
import type {
	Dispatch,
	Lease,
	ReadyNotice,
	WorkOutput,
} from "@mastermind/core";
import type { MastermindClient } from "../src/client.ts";
import type { AgentLauncher, AgentResult, AgentSpec } from "../src/launcher.ts";

export const lease = (ms = 5 * 60_000): Lease => ({
	expiresAt: new Date(Date.now() + ms).toISOString(),
	heartbeatAt: new Date().toISOString(),
});

export function dispatch(id: string, over: Partial<Dispatch> = {}): Dispatch {
	return {
		bead: {
			id,
			title: `title ${id}`,
			status: "in_progress",
			priority: 2,
			type: "task",
			labels: ["queue:q"],
			blocked: false,
			assignee: "alice/laptop",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		queue: "q",
		actor: "alice/laptop",
		lease: lease(),
		stage: "work",
		env: { repo: "", ref: "main", requires: [] },
		prompt: `do ${id}`,
		...over,
	};
}

export type Call = {
	verb: string;
	bead: string;
	actor: string;
	text?: string;
	startFailed?: boolean;
	hold?: boolean;
	output?: WorkOutput;
};

/** Hands out queued dispatches; `next` on an empty queue answers null after `waitMs`. */
export class FakeMastermind implements MastermindClient {
	readonly queues = new Map<string, Dispatch[]>();
	readonly calls: Call[] = [];
	readonly listeners = new Map<string, ((n: ReadyNotice) => void)[]>();
	nextCalls = 0;
	waitMs = 20;
	/** Bead ids whose claim is gone: heartbeat answers conflict. */
	lost = new Set<string>();
	failNext = 0;

	push(d: Dispatch) {
		const list = this.queues.get(d.queue) ?? [];
		list.push(d);
		this.queues.set(d.queue, list);
	}
	ready(queue: string) {
		for (const l of this.listeners.get(queue) ?? [])
			l({ queue, beadId: "x", at: new Date().toISOString() });
	}
	verbs(verb: string) {
		return this.calls.filter((c) => c.verb === verb);
	}

	async next(queue: string) {
		this.nextCalls++;
		if (this.failNext > 0) {
			this.failNext--;
			throw new BusError("unavailable", "no responders");
		}
		const d = this.queues.get(queue)?.shift();
		if (d) return d;
		await Bun.sleep(this.waitMs);
		return null;
	}
	async heartbeat(bead: string, actor: string) {
		this.calls.push({ verb: "heartbeat", bead, actor });
		if (this.lost.has(bead))
			throw new BusError("conflict", `${bead} is not held by ${actor}`);
		return lease();
	}
	async report(bead: string, actor: string, text: string) {
		this.calls.push({ verb: "report", bead, actor, text });
	}
	async complete(
		bead: string,
		actor: string,
		text: string,
		output?: WorkOutput,
	) {
		this.calls.push({
			verb: "complete",
			bead,
			actor,
			text,
			...(output ? { output } : {}),
		});
	}
	async release(
		bead: string,
		actor: string,
		text: string,
		o?: { startFailed?: boolean; hold?: boolean },
	) {
		this.calls.push({
			verb: "release",
			bead,
			actor,
			text,
			...(o?.startFailed ? { startFailed: true } : {}),
			...(o?.hold ? { hold: true } : {}),
		});
	}
	onReady(queue: string, l: (n: ReadyNotice) => void) {
		const list = this.listeners.get(queue) ?? [];
		list.push(l);
		this.listeners.set(queue, list);
		return () => list.splice(list.indexOf(l), 1);
	}
}

/** Agents that finish when the test says so (or at once with `auto`). */
export class FakeLauncher implements AgentLauncher {
	readonly specs: AgentSpec[] = [];
	readonly pending = new Map<string, (r: AgentResult) => void>();
	aborted: string[] = [];
	active = 0;
	maxActive = 0;
	constructor(private readonly auto?: AgentResult) {}

	run(spec: AgentSpec, signal: AbortSignal): Promise<AgentResult> {
		this.specs.push(spec);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		const done = () => {
			this.active--;
		};
		if (this.auto) {
			done();
			return Promise.resolve(this.auto);
		}
		return new Promise<AgentResult>((resolve, reject) => {
			signal.addEventListener("abort", () => {
				this.aborted.push(spec.beadId);
				done();
				reject(new Error("agent stopped"));
			});
			this.pending.set(spec.beadId, (r) => {
				done();
				resolve(r);
			});
		});
	}
	finish(bead: string, r: AgentResult) {
		this.pending.get(bead)?.(r);
		this.pending.delete(bead);
	}
}

/** Poll until `cond` holds or fail after `ms`. */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await Bun.sleep(5);
	}
}
