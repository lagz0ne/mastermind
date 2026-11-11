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
import type {
	EnvironmentAgent,
	EnvironmentLimits,
	EnvironmentNetwork,
	EnvironmentOutput,
	EnvironmentProvider,
} from "./environment.ts";
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

/** A bead names its environment with ONE label `env:<name>`. */
export const ENV_LABEL_PREFIX = "env:";

export function envLabel(name: string): string {
	return `${ENV_LABEL_PREFIX}${name}`;
}

/** Marks a bead the dispatcher holds back: its environment does not resolve. */
export const ENV_TRIAGE_LABEL = "triage:env";

/**
 * Marks a bead the dispatcher holds back: its agent failed to start too many
 * times (the reason is in the notes). A human reopen clears it.
 */
export const FAILED_START_LABEL = "failed:start";

/** The environment name a bead points to, or null. */
export function envNameOf(bead: Pick<Bead, "labels">): string | null {
	const label = bead.labels.find(
		(l) => l.startsWith(ENV_LABEL_PREFIX) && l.length > ENV_LABEL_PREFIX.length,
	);
	return label ? label.slice(ENV_LABEL_PREFIX.length) : null;
}

/** What the runner must prepare before it starts the agent. */
export type DispatchEnv = {
	/**
	 * The environment's name. Absent only for beads that still carry the old
	 * `repo:`/`ref:` labels instead of `env:<name>`.
	 */
	name?: string;
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
	/** Shell commands that prove readiness; run before every start. */
	check?: string[];
	/** Names of secrets the runner must supply. Never the values. */
	secrets?: string[];
	/** The environment's agent preference; the runner's own rules win. */
	agent?: EnvironmentAgent;
	/** Text the environment adds to every prompt. */
	instructions?: string;
	// --- the box recipe (named environments; absent for old label beads)
	/** Base image; empty: the runner's default box image. */
	image?: string;
	/** Lines baked into the cached image. */
	tools?: string[];
	/** sha256 (hex) of {image, tools}: the runner's image cache key. */
	recipeHash?: string;
	limits?: EnvironmentLimits;
	network?: EnvironmentNetwork;
	/** Provider and the name of its login secret (also listed in `secrets`). */
	providerLogin?: EnvironmentProvider;
	output?: EnvironmentOutput;
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
	/** How many agents it runs at once (shown on /people); null: unlimited. */
	capacity?: number | null;
	/** Every queue it takes work from (shown on /people). */
	queues?: string[];
	/** Runner software version. */
	version?: string;
	/**
	 * Environment names bound on this runner. Absent: a legacy runner that
	 * takes any environment. Present: it is offered only these.
	 */
	environments?: string[];
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

/**
 * Give the bead back without finishing it. `startFailed`: the agent did not
 * start (check refused, paseo run failed); the dispatcher counts these.
 */
export type ReleaseRequest = {
	actor: string;
	reason: string;
	startFailed?: boolean;
};

/** Reply of the verbs that return no data. */
export type Ack = { ok: true };

/** Mastermind publishes this when a queue gets work, so idle runners ask `next`. */
export type ReadyNotice = { queue: string; beadId: string; at: string };

/** Connection state of a runner adapter, as the runner itself sees it. */
export type RunnerState = "connecting" | "connected" | "revoked" | "stopping";

/** One dispatch the runner is working on. */
export type RunnerInFlight = {
	itemId: string;
	queue: string;
	stage: DispatchStage;
	/** Routing target; null until routed. */
	target: string | null;
	startedAt: string;
	/** Paseo agent id, when the launcher knows it. */
	paseoAgentId: string | null;
};

/**
 * What a runner publishes about itself on `mm.u.<account>.r.<runner>.status`
 * (every 15 s and on change), for troubleshooting from Mastermind. It holds no
 * secrets: the runner strips credentials and tokens from `lastErrors`.
 */
export type RunnerDiagnostics = {
	runner: string;
	version: string;
	/** When the runner made this snapshot (ISO). */
	at: string;
	state: RunnerState;
	/** The NATS server it is connected to, or null. */
	natsServer: string | null;
	reconnects: number;
	queues: string[];
	/** Most agents at once; null: unlimited. */
	capacity: number | null;
	running: number;
	inFlight: RunnerInFlight[];
	lastNextAt: string | null;
	lastNextResult: "dispatch" | "empty" | "error" | null;
	/** Routing of the last dispatch: target line or decline reason. */
	lastDecision: string | null;
	checks: {
		/** The Paseo daemon answers `paseo ls`. */
		paseo: boolean | null;
		/** Provider name → available (logged in) in Paseo. */
		providers: Record<string, boolean>;
		/** The workdir exists; null when none is set. */
		workdir: boolean | null;
		checkedAt: string | null;
	};
	/** The last 20 problem lines of the runner log, without secrets. */
	lastErrors: string[];
};
