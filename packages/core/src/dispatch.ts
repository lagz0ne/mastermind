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
 *   mm.u.<account>.r.<runner>.offer     DirectOffer      -> (reply subject)
 *     the runner answers with a request:  OfferAnswer      -> OfferResult
 *
 * Two delivery modes. Broadcast: a bead on a queue (`queue:<name>`) goes to the
 * first runner that asks `next`. Direct: a bead with `to:<address>` is OFFERED
 * to that address (one runner `<account>/<runner>`, or each online runner of
 * `<account>` in turn); the runner accepts or declines with a reason.
 */
import type {
	EnvironmentAgent,
	EnvironmentLimits,
	EnvironmentNetwork,
	EnvironmentOutput,
	EnvironmentProvider,
} from "./environment.ts";
import type { Bead, Lease, WorkOutput } from "./work.ts";

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

/** A bead sent to one address (direct delivery) carries ONE label `to:<address>`. */
export const TO_LABEL_PREFIX = "to:";

/** Marks a direct bead that no runner of its address accepted (the reasons are in the notes). */
export const NOT_ACCEPTED_LABEL = "triage:to";

/** Where a direct bead goes: one runner, or any online runner of an account. */
export type Address = { account: string; runner?: string };

const ADDRESS_ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_RUNNER = /^[^\s/.*>~]+$/;

/** `<account>` or `<account>/<runner>`, or null when malformed. */
export function parseAddress(text: string): Address | null {
	const [account, runner, ...rest] = text.split("/");
	if (rest.length || !account || !ADDRESS_ACCOUNT.test(account)) return null;
	if (runner === undefined) return { account };
	return ADDRESS_RUNNER.test(runner) ? { account, runner } : null;
}

export const isAddress = (v: unknown): v is string =>
	typeof v === "string" && parseAddress(v) !== null;

export function toLabel(address: string): string {
	return `${TO_LABEL_PREFIX}${address}`;
}

/** The address of a direct bead, or null. */
export function toOf(bead: Pick<Bead, "labels">): string | null {
	const label = bead.labels.find(
		(l) => l.startsWith(TO_LABEL_PREFIX) && l.length > TO_LABEL_PREFIX.length,
	);
	return label ? label.slice(TO_LABEL_PREFIX.length) : null;
}

/** The `queue` field of a direct dispatch: `to:<address>` (not a real queue). */
export function directQueue(address: string): string {
	return toLabel(address);
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

/**
 * Mastermind offers a direct bead to one runner. It is the dispatch without
 * the claim: the runner decides (capacity, its own routing) before Mastermind
 * claims. `queue` is `to:<address>`.
 */
export type DirectOffer = Omit<Dispatch, "actor" | "lease"> & {
	/** The address the bead was sent to (an account, or this runner). */
	address: string;
};

/** The runner's answer, sent as a request to the offer's reply subject. */
export type OfferAnswer =
	| { accept: true; runner: RunnerInfo }
	| { accept: false; reason: string };

/**
 * Mastermind's reply to the answer. Accept: the dispatch (claimed for the
 * runner), or null with the reason (somebody else took it; the offer timed
 * out). Decline: null.
 */
export type OfferResult = { dispatch: Dispatch | null; reason?: string };

/** Ask for the next bead on a queue. */
export type NextRequest = { runner: RunnerInfo };
/** `dispatch` is null when the queue has nothing the runner can take. */
export type NextReply = { dispatch: Dispatch | null };

/** Keep the lease alive while the agent works. */
export type HeartbeatRequest = { actor: string };
export type HeartbeatReply = { lease: Lease };

/** A progress line from the agent, shown on the board. */
export type ReportRequest = { actor: string; message: string };

/**
 * The stage is done. `output`: what the work left on the git host (box output);
 * Mastermind keeps it on the item, the board links the pull request.
 */
export type CompleteRequest = {
	actor: string;
	summary: string;
	output?: WorkOutput;
};

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
