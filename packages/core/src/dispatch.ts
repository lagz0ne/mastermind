/**
 * Dispatch: how Mastermind hands one bead to one runner (an agent host that an
 * account owns) and how the runner adapter reports back for the agent. These
 * are the payloads of the NATS request/reply subjects that `@mastermind/bus`
 * builds:
 *
 *   mm.u.<account>.q.<queue>.next       NextRequest      -> NextReply
 *   mm.u.<account>.d.<bead>.heartbeat   HeartbeatRequest -> HeartbeatReply
 *   mm.u.<account>.d.<bead>.report      ReportRequest    -> Ack
 *   mm.u.<account>.d.<bead>.complete    CompleteRequest  -> Ack
 *   mm.u.<account>.d.<bead>.release     ReleaseRequest   -> Ack
 *   mm.q.<queue>.ready                  ReadyNotice      (publish)
 */
import type { Bead, Lease } from "./work.ts";

/**
 * One bead passes through up to three stages. Enrichment stages run an agent
 * that rewrites the bead (input) or checks the result (output); `work` does it.
 */
export const DISPATCH_STAGES = [
	"enrich_input",
	"work",
	"enrich_output",
] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number];

/** What the runner must prepare before it starts the agent. */
export type DispatchEnv = {
	/** Git remote URL of the repo to work in. */
	repo: string;
	/** Branch, tag or commit to check out. */
	ref: string;
	/** Agent provider to use (for example `claude`); the runner picks when absent. */
	provider?: string;
	/** Capabilities the runner must have (tools, CLIs, platforms). */
	requires: string[];
	/** Shell commands to run once in the checkout before the agent starts. */
	setup?: string[];
	/** Names of secrets the runner must supply. Never the values. */
	secrets?: string[];
};

/** One unit of dispatched work: this bead, this stage, to this actor. */
export type Dispatch = {
	bead: Bead;
	queue: string;
	/** The claim holder, as `<account>/<agent>`. */
	actor: string;
	lease: Lease;
	stage: DispatchStage;
	env: DispatchEnv;
	/** The full instruction for the agent. */
	prompt: string;
};

/** A runner adapter as it describes itself to Mastermind. */
export type RunnerInfo = {
	/** Stable within the account, for example the host name. */
	id: string;
	/** The account (human) that owns the runner and its work. */
	account: string;
	/** The service account the adapter connects with; owned by `account`. */
	serviceAccount: string;
	/** Agent providers the runner can start. */
	providers: string[];
	/** Capabilities it offers; matched against `DispatchEnv.requires`. */
	capabilities: string[];
	/** How many agents it runs at once (shown on /people). */
	capacity?: number;
	/** Every queue it takes work from (shown on /people). */
	queues?: string[];
	/** Runner software version. */
	version?: string;
};

/** Ask for the next bead on a queue. */
export type NextRequest = { runner: RunnerInfo };
/** `dispatch` is null when the queue has nothing the runner can take. */
export type NextReply = { dispatch: Dispatch | null };

/** Keep the lease alive while the agent works. */
export type HeartbeatRequest = { actor: string };
export type HeartbeatReply = { lease: Lease };

/** A progress line from the agent, shown on the board. */
export type ReportRequest = { actor: string; message: string };

/** The stage is done. */
export type CompleteRequest = { actor: string; summary: string };

/** Give the bead back without finishing it. */
export type ReleaseRequest = { actor: string; reason: string };

/** Reply of the verbs that return no data. */
export type Ack = { ok: true };

/** Mastermind publishes this when a queue gets work, so idle runners ask `next`. */
export type ReadyNotice = { queue: string; beadId: string; at: string };
