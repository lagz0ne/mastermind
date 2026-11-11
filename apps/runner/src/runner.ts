/**
 * The runner loop. One poller per queue asks `next` while a slot is free
 * (capacity slots in total, never more agents than that). Each dispatch:
 *
 *   route (routing.ts) -> declined: release with the reason
 *   check env, setup, check commands -> fail: release with the reason
 *   report "target <name> on <host>, provider <p>"
 *   start agent, heartbeat the lease while it runs (lost lease: stop agent)
 *   agent says done   -> complete with its summary
 *   agent says failed -> release with its reason
 *
 * Agents never talk to Mastermind; the runner reports for them.
 */
import type { Dispatch, RunnerInFlight } from "@mastermind/core";
import { type CheckResult, checkDispatch, type SetupMemory } from "./check.ts";
import {
	BACKOFF,
	type Backoff,
	backoffMs,
	isLostClaim,
	type MastermindClient,
} from "./client.ts";
import type { RunnerSettings } from "./config.ts";
import type { AgentLauncher } from "./launcher.ts";
import {
	type Decision,
	decisionLine,
	implicitRouting,
	type Routing,
	route,
} from "./routing.ts";

type RoutedDecision = Extract<Decision, { ok: true }>;

export type RunnerOptions = {
	client: MastermindClient;
	launcher: AgentLauncher;
	settings: RunnerSettings;
	/** The user's routing; default: the implicit routing of the settings. */
	routing?: Routing;
	check?: (
		d: Dispatch,
		s: RunnerSettings,
		decision: RoutedDecision,
	) => Promise<CheckResult>;
	/** Where setup runs are remembered; default: in this process only. */
	setupMemory?: SetupMemory;
	log?: (line: string) => void;
	/** Longest gap between heartbeats. Default 60 s (bd leases last 5 min). */
	heartbeatMs?: number;
	/** Pause after an empty `next`, cut short by a ready notice. Default 2 s. */
	idleMs?: number;
	backoff?: Backoff;
	/** Called when in-flight work, the last `next` or the last decision changes. */
	onChange?: () => void;
};

/** A FIFO counting semaphore. */
class Slots {
	#free: number;
	readonly #waiters: (() => void)[] = [];
	constructor(n: number) {
		this.#free = n;
	}
	get free() {
		return this.#free;
	}
	/** Resolves with a slot; on abort it resolves without one (check the signal). */
	acquire(signal?: AbortSignal): Promise<void> {
		if (this.#free > 0) {
			this.#free--;
			return Promise.resolve();
		}
		if (signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const waiter = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				const i = this.#waiters.indexOf(waiter);
				if (i >= 0) this.#waiters.splice(i, 1);
				resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push(waiter);
		});
	}
	release(): void {
		const next = this.#waiters.shift();
		if (next) next();
		else this.#free++;
	}
	/** Wake every waiter (on stop). */
	drain(): void {
		for (const w of this.#waiters.splice(0)) w();
	}
}

/** Sleep `ms`, or less when `signal` aborts. Never throws. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** Durable id of one execution: the bead and the claim that started it. */
export function executionId(d: Pick<Dispatch, "bead" | "lease">): string {
	const stamp = Date.parse(d.lease.expiresAt);
	return `${d.bead.id}-${Number.isNaN(stamp) ? "0" : stamp.toString(36)}`;
}

/** The agent's prompt: Mastermind's instruction plus how to finish. */
export function agentPrompt(d: Dispatch): string {
	return `${d.prompt}

---
Mastermind dispatched this to you: bead ${d.bead.id}, queue ${d.queue}, stage ${d.stage}.
Do not claim, update or close the bead yourself; the runner reports for you.
When you finish, answer with status "done" and a short summary of the result.
If you cannot finish, answer with status "failed" and the reason.`;
}

type Execution = {
	dispatch: Dispatch;
	abort: AbortController;
	/** Why it was aborted. */
	why?: "stopped" | "lost";
	done: Promise<void>;
	startedAt: string;
	target: string | null;
};

/** Read at call time (the heartbeat sets `why` concurrently). */
const lost = (e: Execution) => e.why === "lost";

export class Runner {
	readonly #o: RunnerOptions;
	readonly #log: (line: string) => void;
	readonly #slots: Slots;
	readonly #routing: Routing;
	readonly #targets = new Map<string, Slots>();
	readonly #running = new Map<string, Execution>();
	readonly #stop = new AbortController();
	readonly #wake = new Map<string, AbortController>();
	#pollers: Promise<void>[] = [];
	#unsubscribe: (() => void)[] = [];
	/** For diagnostics: when the last `next` answered, and how. */
	lastNextAt: string | null = null;
	lastNextResult: "dispatch" | "empty" | "error" | null = null;
	/** For diagnostics: routing of the last dispatch (target line or decline). */
	lastDecision: string | null = null;

	constructor(options: RunnerOptions) {
		this.#o = options;
		this.#log = options.log ?? (() => {});
		this.#slots = new Slots(options.settings.capacity);
		this.#routing = options.routing ?? implicitRouting(options.settings);
	}

	/** Beads with a running agent. */
	running(): string[] {
		return [...this.#running.keys()];
	}

	/** The dispatches being worked on, for diagnostics. */
	inFlight(): RunnerInFlight[] {
		return [...this.#running.values()].map((e) => ({
			itemId: e.dispatch.bead.id,
			queue: e.dispatch.queue,
			stage: e.dispatch.stage,
			target: e.target,
			startedAt: e.startedAt,
			paseoAgentId: null,
		}));
	}

	#changed(): void {
		try {
			this.#o.onChange?.();
		} catch {}
	}

	#nextResult(r: "dispatch" | "empty" | "error"): void {
		this.lastNextAt = new Date().toISOString();
		this.lastNextResult = r;
		this.#changed();
	}

	/** Start polling every queue. */
	start(): void {
		const { queues } = this.#o.settings;
		if (queues.length === 0) throw new Error("runner has no queues");
		for (const q of queues) {
			this.#unsubscribe.push(
				this.#o.client.onReady(q, () => this.#wake.get(q)?.abort()),
			);
			this.#pollers.push(this.#poll(q));
		}
	}

	/** Stop polling; stop running agents and give their beads back. */
	async stop(): Promise<void> {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		for (const u of this.#unsubscribe.splice(0)) u();
		this.#slots.drain();
		for (const e of this.#running.values()) {
			e.why ??= "stopped";
			e.abort.abort();
		}
		await Promise.all(this.#pollers);
		await Promise.all([...this.#running.values()].map((e) => e.done));
	}

	get #stopped() {
		return this.#stop.signal.aborted;
	}

	/** Sleep until `ms` passed, the queue got a ready notice, or stop. */
	async #idle(queue: string, ms: number): Promise<void> {
		const wake = new AbortController();
		this.#wake.set(queue, wake);
		const both = AbortSignal.any([wake.signal, this.#stop.signal]);
		await sleep(ms, both);
		if (this.#wake.get(queue) === wake) this.#wake.delete(queue);
	}

	async #poll(queue: string): Promise<void> {
		const { client } = this.#o;
		let failures = 0;
		while (!this.#stopped) {
			await this.#slots.acquire();
			if (this.#stopped) break;
			let dispatch: Dispatch | null;
			try {
				dispatch = await client.next(queue);
				failures = 0;
				this.#nextResult(dispatch ? "dispatch" : "empty");
			} catch (error) {
				this.#nextResult("error");
				this.#slots.release();
				failures++;
				const wait = backoffMs(failures, this.#o.backoff ?? BACKOFF);
				this.#log(`next ${queue}: ${error}; retrying in ${wait}ms`);
				await this.#idle(queue, wait);
				continue;
			}
			if (!dispatch) {
				this.#slots.release();
				await this.#idle(queue, this.#o.idleMs ?? 2_000);
				continue;
			}
			if (this.#stopped) {
				this.#slots.release();
				await this.#safe(dispatch, "release", "runner stopped");
				break;
			}
			this.#begin(dispatch);
		}
	}

	#begin(dispatch: Dispatch): void {
		const exec: Execution = {
			dispatch,
			abort: new AbortController(),
			done: Promise.resolve(),
			startedAt: new Date().toISOString(),
			target: null,
		};
		this.#running.set(dispatch.bead.id, exec);
		this.#changed();
		exec.done = this.#execute(exec).finally(() => {
			this.#running.delete(dispatch.bead.id);
			this.#slots.release();
			this.#changed();
		});
	}

	async #execute(exec: Execution): Promise<void> {
		const d = exec.dispatch;
		const { launcher, settings } = this.#o;
		const id = d.bead.id;
		this.#log(`${id}: dispatched (${d.queue}, ${d.stage})`);

		const decision = route(d, this.#routing, settings.providers);
		this.lastDecision = decision.ok
			? `${id}: ${decisionLine(decision, settings.id)}`
			: `${id}: declined: ${decision.reason}`;
		if (decision.ok) exec.target = decision.target;
		this.#changed();
		if (!decision.ok) {
			this.#log(`${id}: declined: ${decision.reason}`);
			await this.#safe(d, "release", decision.reason);
			return;
		}
		// Setup may take longer than a lease: heartbeat from here on.
		const beating = this.#heartbeat(exec);
		let target: Slots | undefined;
		try {
			const check = await (this.#o.check ?? this.#check)(
				d,
				settings,
				decision,
			).catch(
				(error): CheckResult => ({
					ok: false,
					reason: `check failed: ${error}`,
				}),
			);
			if (lost(exec)) return;
			if (!check.ok) {
				this.#log(`${id}: refused: ${check.reason}`);
				await this.#safe(d, "release", check.reason);
				return;
			}
			target = this.#targetSlots(decision.target);
			if (target) {
				await target.acquire(exec.abort.signal);
			}
			if (exec.abort.signal.aborted) {
				if (!lost(exec)) await this.#safe(d, "release", "runner stopped");
				return;
			}
			await this.#safe(d, "report", decisionLine(decision, settings.id));
			let result: { status: "done" | "failed"; summary: string };
			try {
				result = await launcher.run(
					{
						executionId: executionId(d),
						beadId: id,
						title: `${id}: ${d.bead.title}`.slice(0, 120),
						cwd: check.cwd,
						prompt: agentPrompt(d),
						agent: decision.agent,
						labels: decision.labels,
						...(decision.host ? { host: decision.host } : {}),
						...(Object.keys(check.env).length ? { env: check.env } : {}),
					},
					exec.abort.signal,
				);
			} catch (error) {
				result = {
					status: "failed",
					summary: `agent did not finish: ${error instanceof Error ? error.message : error}`,
				};
			}
			if (lost(exec)) {
				this.#log(`${id}: lease lost; result dropped`);
				return;
			}
			if (exec.why === "stopped") {
				await this.#safe(d, "release", "runner stopped");
				return;
			}
			this.#log(`${id}: agent ${result.status}`);
			if (result.status === "done")
				await this.#safe(d, "complete", result.summary || "done");
			else await this.#safe(d, "release", result.summary || "agent failed");
		} finally {
			target?.release();
			exec.abort.abort();
			await beating;
		}
	}

	readonly #check = (
		d: Dispatch,
		s: RunnerSettings,
		decision: RoutedDecision,
	): Promise<CheckResult> =>
		checkDispatch(d, s, decision, { setupMemory: this.#o.setupMemory });

	/** Slots of a target with a capacity; undefined when unlimited. */
	#targetSlots(name: string): Slots | undefined {
		const cap = this.#routing.targets[name]?.capacity;
		if (!cap) return undefined;
		let slots = this.#targets.get(name);
		if (!slots) {
			slots = new Slots(cap);
			this.#targets.set(name, slots);
		}
		return slots;
	}

	/** Renew the lease until the execution ends; a lost claim stops the agent. */
	async #heartbeat(exec: Execution): Promise<void> {
		const d = exec.dispatch;
		const max = this.#o.heartbeatMs ?? 60_000;
		let lease = d.lease;
		while (!exec.abort.signal.aborted) {
			const left = Date.parse(lease.expiresAt) - Date.now();
			const wait = Math.max(
				200,
				Math.min(max, Number.isNaN(left) ? max : left / 3),
			);
			await sleep(wait, exec.abort.signal);
			if (exec.abort.signal.aborted) return;
			try {
				lease = await this.#o.client.heartbeat(d.bead.id, d.actor);
			} catch (error) {
				if (isLostClaim(error)) {
					this.#log(`${d.bead.id}: claim lost (${error}); stopping the agent`);
					exec.why ??= "lost";
					exec.abort.abort();
					return;
				}
				this.#log(`${d.bead.id}: heartbeat failed: ${error}`);
			}
		}
	}

	/** A bead verb with a few retries; a lost claim or final failure is logged. */
	async #safe(
		d: Dispatch,
		verb: "report" | "complete" | "release",
		text: string,
	): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				await this.#o.client[verb](d.bead.id, d.actor, text);
				return;
			} catch (error) {
				if (isLostClaim(error) || attempt === 3) {
					this.#log(`${d.bead.id}: ${verb} failed: ${error}`);
					return;
				}
				await sleep(backoffMs(attempt, this.#o.backoff ?? BACKOFF));
			}
		}
	}
}
