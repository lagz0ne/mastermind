/**
 * The runner loop. One poller per queue asks `next` while a slot is free
 * (capacity slots in total, never more agents than that). Each dispatch:
 *
 *   check env  -> fail: release with the reason
 *   start agent, heartbeat the lease while it runs (lost lease: stop agent)
 *   agent says done   -> complete with its summary
 *   agent says failed -> release with its reason
 *
 * Agents never talk to Mastermind; the runner reports for them.
 */
import type { Dispatch } from "@mastermind/core";
import { type CheckResult, checkDispatch } from "./check.ts";
import {
	BACKOFF,
	type Backoff,
	backoffMs,
	isLostClaim,
	type MastermindClient,
} from "./client.ts";
import type { RunnerSettings } from "./config.ts";
import type { AgentLauncher } from "./launcher.ts";

export type RunnerOptions = {
	client: MastermindClient;
	launcher: AgentLauncher;
	settings: RunnerSettings;
	check?: (d: Dispatch, s: RunnerSettings) => Promise<CheckResult>;
	log?: (line: string) => void;
	/** Longest gap between heartbeats. Default 60 s (bd leases last 5 min). */
	heartbeatMs?: number;
	/** Pause after an empty `next`, cut short by a ready notice. Default 2 s. */
	idleMs?: number;
	backoff?: Backoff;
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
	acquire(): Promise<void> {
		if (this.#free > 0) {
			this.#free--;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#waiters.push(resolve));
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
};

export class Runner {
	readonly #o: RunnerOptions;
	readonly #log: (line: string) => void;
	readonly #slots: Slots;
	readonly #running = new Map<string, Execution>();
	readonly #stop = new AbortController();
	readonly #wake = new Map<string, AbortController>();
	#pollers: Promise<void>[] = [];
	#unsubscribe: (() => void)[] = [];

	constructor(options: RunnerOptions) {
		this.#o = options;
		this.#log = options.log ?? (() => {});
		this.#slots = new Slots(options.settings.capacity);
	}

	/** Beads with a running agent. */
	running(): string[] {
		return [...this.#running.keys()];
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
			} catch (error) {
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
		};
		this.#running.set(dispatch.bead.id, exec);
		exec.done = this.#execute(exec).finally(() => {
			this.#running.delete(dispatch.bead.id);
			this.#slots.release();
		});
	}

	async #execute(exec: Execution): Promise<void> {
		const d = exec.dispatch;
		const { launcher, settings } = this.#o;
		const id = d.bead.id;
		this.#log(`${id}: dispatched (${d.queue}, ${d.stage})`);

		const check = await (this.#o.check ?? checkDispatch)(d, settings).catch(
			(error): CheckResult => ({ ok: false, reason: `check failed: ${error}` }),
		);
		if (!check.ok) {
			this.#log(`${id}: refused: ${check.reason}`);
			await this.#safe(d, "release", check.reason);
			return;
		}

		if (exec.abort.signal.aborted) {
			await this.#safe(d, "release", "runner stopped");
			return;
		}
		const beating = this.#heartbeat(exec);
		try {
			const provider = check.agent.provider ?? "default";
			await this.#safe(
				d,
				"report",
				`runner ${settings.id}: starting a ${provider} agent`,
			);
			let result: { status: "done" | "failed"; summary: string };
			try {
				result = await launcher.run(
					{
						executionId: executionId(d),
						beadId: id,
						title: `${id}: ${d.bead.title}`.slice(0, 120),
						cwd: check.cwd,
						prompt: agentPrompt(d),
						agent: check.agent,
					},
					exec.abort.signal,
				);
			} catch (error) {
				result = {
					status: "failed",
					summary: `agent did not finish: ${error instanceof Error ? error.message : error}`,
				};
			}
			if (exec.why === "lost") {
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
			exec.abort.abort();
			await beating;
		}
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
