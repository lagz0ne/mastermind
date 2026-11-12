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
	BoxRuntime,
	DevcontainerSettings,
	EnvironmentLimits,
	EnvironmentNetwork,
	EnvironmentOutput,
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

/**
 * Marks a bead the dispatcher holds back: it was claimed and then released or
 * its lease expired too many times (the last reasons are in the notes). Like a
 * dead-letter queue after SQS maxReceiveCount. A human reopen clears it.
 */
export const NEEDS_HUMAN_LABEL = "needs:human";

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

/**
 * One agent provider as Paseo reports it on a runner's host (mm-210.84).
 * Mastermind stores no agent settings: it only shows what Paseo says.
 */
export type PaseoProviderState = {
	name: string;
	/** Paseo's word: ready, loading, error, unavailable. */
	status: string;
	enabled: boolean;
	/**
	 * Paseo's diagnostic `Auth.loggedIn`; null: not asked (box mode: the agent
	 * logs in in the box) or not said. True means a credential is present,
	 * not that it is accepted (mm-210.80).
	 */
	loggedIn: boolean | null;
	/** The mode an agent gets when none is set; null: Paseo does not say. */
	defaultMode: string | null;
	modes: string[];
	/** Model ids Paseo lists; empty: not known. */
	models: string[];
	/** Paseo's reason when not ready. */
	error?: string;
};

/**
 * What the runner must prepare before it starts the agent. No agent settings
 * (provider, model, mode): the runner decides them with Paseo (mm-210.84).
 */
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
	/** Capabilities the runner must have (tools, CLIs, platforms). */
	requires: string[];
	/** Shell commands to run once in the checkout before the agent starts. */
	setup?: string[];
	/** Shell commands that prove readiness; run before every start. */
	check?: string[];
	/** Names of secrets the runner must supply. Never the values. */
	secrets?: string[];
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
	/** Container runtime of the box; absent: the engine's default (mm-210.63). */
	runtime?: BoxRuntime;
	output?: EnvironmentOutput;
	/** The box from a devcontainer.json; absent: see {@link DevcontainerSettings}. */
	devcontainer?: DevcontainerSettings;
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
	/**
	 * One id per runner process (mm-210.79), new at every start. Mastermind
	 * keeps one live session per `<account>/<runner>`: the newer one wins, an
	 * older one is told {@link NextReply.superseded}. Absent: a runner older
	 * than that; it is refused while a session of the same runner is live.
	 */
	session?: string;
	/** When this process started (ISO); compares two sessions. */
	startedAt?: string;
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
/**
 * `dispatch` is null when the queue has nothing the runner can take.
 * `notReady`: Mastermind does not give this runner work yet (readiness gate,
 * mm-210.59); each line says why.
 */
export type NextReply = {
	dispatch: Dispatch | null;
	notReady?: string[];
	/**
	 * A newer process of the same runner runs (mm-210.79): this one gets no
	 * more work and should stop. The line says which session won.
	 */
	superseded?: string;
};

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
		/**
		 * Every provider as the runner's Paseo reports it (mm-210.84), in
		 * Paseo's order. Absent: a runner older than that.
		 */
		paseoProviders?: PaseoProviderState[];
	};
	/** The last 20 problem lines of the runner log, without secrets. */
	lastErrors: string[];
	/** Worker readiness (mm-210.59); absent: a runner older than that. */
	readiness?: RunnerReadiness;
	/** The process's session (see {@link RunnerInfo.session}); absent: older runner. */
	session?: string;
	startedAt?: string;
};

/**
 * Worker readiness (mm-210.59). `onboarding`: `onboard` has not finished on
 * this machine. `checking`: the first checks run. `ready`: the runner-level
 * checks pass. `degraded`: a later check fails. Only `ready` gets work.
 */
export const READINESS_STATES = [
	"onboarding",
	"checking",
	"ready",
	"degraded",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** One failed check: runner-wide, or for one environment only. */
export type FailedCheck = {
	/** Short id, for example `engine`, `paseo`, `secrets`. */
	check: string;
	/** Set: only this environment is not ready. */
	environment?: string;
	problem: string;
	/** One line that fixes it. */
	fix?: string;
};

/** What the runner says about its readiness, in its status. */
export type RunnerReadiness = {
	state: ReadinessState;
	/** Environments it may get work for (empty unless `ready`). */
	readyEnvironments: string[];
	failedChecks: FailedCheck[];
	/** When the checks last ran (ISO); null: not yet. */
	checkedAt: string | null;
};

/** The dispatcher trusts a runner status for this long (ms). */
export const READINESS_FRESH_MS = 120_000;

/** Which process asks: its session, else its version (an older runner). */
export type ProcessOf = { session?: string; version?: string };

/**
 * The status is from another process of the same runner id (two processes
 * run, mm-210.79): the line says so; null: same process, or it cannot tell.
 * A process with a session needs a status with that session. A process
 * without one (older runner) needs a status without a session and, when both
 * say a version, the same version.
 */
export function otherProcess(
	status: ProcessOf,
	from: ProcessOf,
): string | null {
	const s = (p: ProcessOf) =>
		typeof p.session === "string" && p.session ? p.session : null;
	const v = (p: ProcessOf) =>
		typeof p.version === "string" && p.version ? p.version : null;
	const them = s(status)
		? `session ${s(status)?.slice(0, 8)}`
		: `version ${v(status) ?? "?"}`;
	const me = s(from)
		? `session ${s(from)?.slice(0, 8)}`
		: `version ${v(from) ?? "?"}`;
	const line = `its last status is from another process of this runner (${them}; this request: ${me}): two processes run, stop one`;
	if (s(from)) return s(status) === s(from) ? null : line;
	if (s(status)) return line;
	return v(from) && v(status) && v(from) !== v(status) ? line : null;
}

/**
 * Why a runner may not get work (empty: it may). `status`: the runner's last
 * status; `receivedAt`: when Mastermind got it (ms). `environment`: the
 * item's environment; null: the item has none (state `ready` is enough).
 * `from`: the process that asks (mm-210.79); a status of another process of
 * the same runner id does not make it ready. Absent: not checked.
 */
export function notReadyReasons(
	status: ({ readiness?: RunnerReadiness } & ProcessOf) | null,
	receivedAt: number | null,
	now: number,
	environment: string | null = null,
	from?: ProcessOf,
): string[] {
	if (!status || receivedAt === null)
		return [
			"no status from the runner yet (start it; a runner from before mm-210.59 must be updated and run: mastermind-runner onboard)",
		];
	const other = from ? otherProcess(status, from) : null;
	if (other) return [other];
	const age = now - receivedAt;
	if (age > READINESS_FRESH_MS)
		return [
			`its last status is ${Math.round(age / 1000)} s old (fresh: ${READINESS_FRESH_MS / 1000} s)`,
		];
	const r = status.readiness;
	if (!r)
		return [
			"it does not report readiness (update it, then run: mastermind-runner onboard)",
		];
	if (r.state !== "ready") {
		const own = r.failedChecks.filter((c) => !c.environment);
		return [
			`state ${r.state}${own.length ? `: ${own.map((c) => c.problem).join("; ")}` : ""}`,
		];
	}
	if (environment === null || r.readyEnvironments.includes(environment))
		return [];
	const env = r.failedChecks.filter((c) => c.environment === environment);
	return [
		`environment ${environment} is not ready on it${env.length ? `: ${env.map((c) => c.problem).join("; ")}` : ""}`,
	];
}
