import { type JournalSource, tailJournal } from "@mastermind/beads";
import type { BeadEvent } from "@mastermind/core";

export type HubOptions = {
	/** Journal head at start: the tail follows from here. */
	head: () => Promise<number>;
	/** Poll interval of the tail once the journal is drained. Default 300 ms. */
	intervalMs?: number;
	/** Pause before restarting a failed tail. Default 2 s. */
	retryMs?: number;
	onError?: (error: unknown) => void;
};

export type Listener = (event: BeadEvent) => void;

export type Subscription = {
	/**
	 * Resolves to a seq X such that this listener gets every event after X.
	 * Events up to X are the caller's backlog: read them from the journal.
	 */
	position: Promise<number>;
	unsubscribe(): void;
};

type Run = {
	abort: AbortController;
	/** Last seq dispatched (or the head the tail started at); null until known. */
	cursor: number | null;
	started: Promise<void>;
};

/**
 * ONE journal tail for all clients. It runs while at least one listener is
 * subscribed and fans every event out to all of them, in seq order.
 */
export class JournalHub {
	readonly #source: JournalSource;
	readonly #options: HubOptions;
	readonly #listeners = new Set<Listener>();
	#run: Run | null = null;
	/** Number of tails started so far (for tests and logs). */
	tails = 0;

	constructor(source: JournalSource, options: HubOptions) {
		this.#source = source;
		this.#options = options;
	}

	get listeners(): number {
		return this.#listeners.size;
	}

	subscribe(listener: Listener): Subscription {
		this.#listeners.add(listener);
		const run = this.#run ?? this.#start();
		// Every event after the cursor at the moment we read it reaches the
		// listener: dispatch is synchronous and the listener is already in.
		const position = run.started.then(() => run.cursor ?? 0);
		return {
			position,
			unsubscribe: () => {
				if (!this.#listeners.delete(listener)) return;
				if (this.#listeners.size === 0) this.stop();
			},
		};
	}

	stop(): void {
		this.#run?.abort.abort();
		this.#run = null;
	}

	#start(): Run {
		let markStarted = () => {};
		const run: Run = {
			abort: new AbortController(),
			cursor: null,
			started: new Promise((resolve) => {
				markStarted = resolve;
			}),
		};
		this.#run = run;
		this.tails++;
		void this.#follow(run, markStarted);
		return run;
	}

	async #follow(run: Run, markStarted: () => void): Promise<void> {
		const { intervalMs = 300, retryMs = 2_000, onError } = this.#options;
		const signal = run.abort.signal;
		while (!signal.aborted) {
			try {
				if (run.cursor === null) {
					run.cursor = await this.#options.head();
					markStarted();
				}
				for await (const event of tailJournal(this.#source, {
					since: run.cursor,
					intervalMs,
					signal,
				})) {
					run.cursor = event.seq;
					for (const listener of this.#listeners) {
						try {
							listener(event);
						} catch (error) {
							onError?.(error);
						}
					}
				}
			} catch (error) {
				onError?.(error);
				await Bun.sleep(retryMs);
			}
		}
		// A stopped run never got a head: let waiters go (they are gone anyway).
		markStarted();
	}
}
