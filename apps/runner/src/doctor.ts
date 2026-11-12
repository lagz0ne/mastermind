/**
 * `mastermind-runner doctor [--deep]` (mm-210.47): test the path a dispatch
 * really takes, step by step, each PASS / WARN / FAIL / SKIP with its time
 * and a fix line.
 *
 *   a. config     config readable, credential valid, server vs runner version
 *   b. nats       connect (time it), auth, publish on the status subject
 *   c. routing    the runner's decision for a sample dispatch per queue:
 *                 target, host, provider, mode, the paseo command line
 *   d. paseo      daemon answers, the decided provider is available, its mode
 *                 does not ask for permission, checkouts are git dirs
 *   e. agent      --deep only: a REAL `paseo run` with the arguments a dispatch
 *                 uses ("Reply with the single word OK"), then archive it
 *   f. secrets    every secret the environments need is present locally
 *                 (names only; FAIL with 'mastermind-runner secrets set <NAME>')
 *   g. box        the box engine answers (Docker/Podman API) and the default
 *                 image is present or pullable; --deep: make a box from it,
 *                 wait for `paseo status --json` in it, delete it (times each).
 *                 SKIP when the runner runs with --no-box.
 *   h. model      the Claude credential the box uses (CLAUDE_CODE_OAUTH_TOKEN,
 *                 else ANTHROPIC_API_KEY): one GET /v1/models with the header
 *                 the box proxy sets upstream; refused = FAIL (mm-210.80).
 *
 * No secret is printed: secrets reach the agent as files; the command line shows only their directory.
 */
import { existsSync, statSync } from "node:fs";
import { type ConnectOptions, connect, subjects } from "@mastermind/bus";
import { type Dispatch, runnerVersionNotice } from "@mastermind/core";
import type { Box, BoxDriver } from "./box/driver.ts";
import { BOX_LABEL, ENGINE_RUNTIME } from "./box/driver.ts";
import { DEFAULT_BOX_IMAGE } from "./box/image.ts";
import { BOX_ENV } from "./box/run.ts";
import {
	type CredentialState,
	checkCredential,
	isAuthFailure,
} from "./client.ts";
import type { RunnerConfig, RunnerSettings } from "./config.ts";
import {
	type AgentLauncher,
	type AgentSpec,
	PaseoLauncher,
	PROVIDER_LOGIN_FIX,
	providerLoginMessage,
	RESULT_SCHEMA,
	secretsArgs,
} from "./launcher.ts";
import {
	checkModelSecret,
	modelCheckText,
	modelCredentialFix,
} from "./model-check.ts";
import { type Decision, type Routing, route } from "./routing.ts";
import type { SecretsState } from "./secrets/state.ts";

export type StepStatus = "pass" | "warn" | "fail" | "skip";
export type DoctorStep = {
	id: "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
	name: string;
	status: StepStatus;
	ms: number;
	/** What was checked and seen, one line each. */
	detail: string[];
	/** The line that made the step WARN or FAIL. */
	problem?: string;
	/** How to fix a WARN or FAIL. */
	fix?: string;
};
export type DoctorReport = {
	runner: string;
	at: string;
	deep: boolean;
	ok: boolean;
	steps: DoctorStep[];
};

/** The part of a NATS connection the doctor uses. */
export type DoctorNats = {
	publish(subject: string, data?: Uint8Array): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	getServer(): string;
};

export type PaseoExec = (
	args: string[],
	host?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type DoctorDeps = {
	fetch?: typeof fetch;
	connect?: (o: ConnectOptions) => Promise<DoctorNats>;
	paseo?: PaseoExec;
	launcher?: AgentLauncher & {
		find(executionId: string, host?: string): Promise<string[]>;
	};
	isGitDir?: (dir: string) => Promise<boolean>;
	/** Monotonic ms, for step times. */
	clock?: () => number;
	/** Wait between box readiness polls. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
};

export type DoctorInput = {
	/** null: not enrolled. */
	config: RunnerConfig | null;
	configPath: string;
	settings: RunnerSettings;
	routing: Routing;
	routingSource: string;
	mastermindUrl?: string;
	natsUrl?: string;
	/** The runner's version (cli.ts VERSION). */
	version: string;
	/** Run step e: a real agent. */
	deep: boolean;
	/** Problems the cli found in status.json (the running runner): WARN in step a. */
	runnerProblems?: { problem: string; fix: string }[];
	/** Step f: the secrets state (secrets/state.ts); absent: no step f. */
	secrets?: () => Promise<SecretsState>;
	/** Step e timeout, ms. */
	agentTimeoutMs?: number;
	/** Step g: box mode; absent: no step g. */
	box?: DoctorBox;
	/** Step g --deep: longest wait for the agent host in the box, ms. */
	boxReadyTimeoutMs?: number;
	/** Step h: the model credential the box uses (value and where it is from); absent: no step h. */
	model?: () => Promise<DoctorModel | null>;
	/** Step h: Anthropic's base URL (tests). */
	modelUpstream?: string;
};

/** The model credential of the box, as the runner resolves it (never printed). */
export type DoctorModel = {
	secret: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
	value: string;
	from: string;
};

/** How the runner runs agents: in boxes (driver + default image) or not (--no-box). */
export type DoctorBox =
	| { noBox: true }
	| { noBox?: false; driver: BoxDriver; image: string };

export const BOX_READY_TIMEOUT_MS = 60_000;
const NO_BOX_FIX =
	"start Docker, or set DOCKER_HOST (Podman: podman system service --time=0 unix://<path>), or start the runner with --no-box at your own risk";

export const NATS_SLOW_MS = 2_000;
export const AGENT_TIMEOUT_MS = 120_000;
export const PROBE_PROMPT =
	"Mastermind runner doctor probe. Reply with the single word OK. Do not use any tool. Answer with status done and summary OK.";

/**
 * Modes known to stop and wait for a human before a tool runs. An unattended
 * agent in such a mode never answers: `paseo run` fails with
 * OUTPUT_SCHEMA_FAILED "waiting for permission".
 */
const ASKING_MODES: Record<string, string[]> = {
	claude: ["default", "plan", "acceptEdits"],
};

/** Does `mode` of `provider` ask for permission? Unknown modes: false. */
export function asksPermission(provider: string, mode: string): boolean {
	const p = provider.split("/")[0] as string;
	return ASKING_MODES[p]?.includes(mode) ?? false;
}

/** A mode that does not ask, to name in a fix line. */
const UNATTENDED_MODE: Record<string, string> = { claude: "auto" };

/** `paseo run ...` as a dispatch would call it, without secret values. */
export function paseoCommandLine(
	spec: Pick<AgentSpec, "title" | "cwd" | "agent" | "labels" | "host"> & {
		envNames?: string[];
	},
): string {
	const q = (s: string) =>
		/^[A-Za-z0-9_./:=@,+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
	const a = spec.agent;
	const args = [
		"paseo",
		"run",
		"--json",
		"--output-schema",
		JSON.stringify(RESULT_SCHEMA),
		"--title",
		spec.title,
		"--cwd",
		spec.cwd,
		...(a.provider ? ["--provider", a.provider] : []),
		...(a.model ? ["--model", a.model] : []),
		...(a.mode ? ["--mode", a.mode] : []),
		...Object.entries(spec.labels ?? {}).flatMap(([k, v]) => [
			"--label",
			`${k}=${v}`,
		]),
		...(spec.envNames?.length ? secretsArgs("<dir>") : []),
		...(spec.host ? ["--host", spec.host] : []),
		"<prompt>",
	];
	return args.map((s) => (s === "<prompt>" ? s : q(s))).join(" ");
}

function withoutPaseoAgentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && k !== "PASEO_AGENT_ID" && k !== "PASEO_AGENT_CWD")
			env[k] = v;
	return env;
}

const paseoExec: PaseoExec = async (args, host) => {
	try {
		const proc = Bun.spawn(
			["paseo", ...args, ...(host ? ["--host", host] : [])],
			{
				env: withoutPaseoAgentEnv(),
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const timer = setTimeout(() => proc.kill(), 15_000);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		clearTimeout(timer);
		return { code, stdout, stderr };
	} catch (error) {
		return { code: 127, stdout: "", stderr: String(error) };
	}
};

async function gitDir(dir: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "-C", dir, "rev-parse"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/** A Paseo CLI failure in one line: its JSON error (code: message), else the output tail. */
export function paseoError(r: {
	code: number;
	stdout: string;
	stderr: string;
}): string {
	for (const text of [r.stdout, r.stderr]) {
		try {
			const e = (
				JSON.parse(text) as { error?: { code?: string; message?: string } }
			).error;
			if (e?.message) return e.code ? `${e.code}: ${e.message}` : e.message;
		} catch {}
	}
	const tail = `${r.stderr}\n${r.stdout}`
		.replace(/\s+/g, " ")
		.trim()
		.slice(-300);
	return tail || `exit ${r.code}`;
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

const RANK: Record<StepStatus, number> = { skip: 0, pass: 1, warn: 2, fail: 3 };

/** Collects the checks of one step; the worst status wins, the first fix of it is kept. */
class Step {
	status: StepStatus = "pass";
	readonly detail: string[] = [];
	problem?: string;
	fix?: string;
	ok(line: string) {
		this.detail.push(line);
	}
	warn(line: string, fix?: string) {
		this.#mark("warn", line, fix);
	}
	fail(line: string, fix?: string) {
		this.#mark("fail", line, fix);
	}
	#mark(s: StepStatus, line: string, fix?: string) {
		this.detail.push(line);
		if (RANK[s] > RANK[this.status]) {
			this.status = s;
			this.problem = line;
			this.fix = fix;
		} else if (s === this.status && !this.fix) this.fix = fix;
	}
}

type ProviderInfo = {
	provider?: string;
	status?: string;
	defaultMode?: string;
};

/** A sample dispatch for `queue`: what the routing decides for plain work there. */
function sample(queue: string): Dispatch {
	return {
		bead: {
			id: "doctor",
			title: "doctor",
			status: "open",
			priority: 2,
			type: "task",
			labels: [],
			blocked: false,
			createdAt: "",
			updatedAt: "",
		},
		env: { repo: "", ref: "", requires: [] },
		stage: "work",
		queue,
		actor: "",
		lease: { expiresAt: "", heartbeatAt: "" },
		prompt: "",
	} as unknown as Dispatch;
}

export async function runDoctor(
	input: DoctorInput,
	deps: DoctorDeps = {},
): Promise<DoctorReport> {
	const clock = deps.clock ?? (() => performance.now());
	const paseo = deps.paseo ?? paseoExec;
	const isGit = deps.isGitDir ?? gitDir;
	const s = input.settings;
	const cfg = input.config;
	const steps: DoctorStep[] = [];
	const timed = async (
		id: DoctorStep["id"],
		name: string,
		fn: (st: Step) => Promise<void> | void,
	) => {
		const t0 = clock();
		const st = new Step();
		try {
			await fn(st);
		} catch (error) {
			st.fail(
				`unexpected error: ${error instanceof Error ? error.message : error}`,
			);
		}
		steps.push({
			id,
			name,
			status: st.status,
			ms: Math.round(clock() - t0),
			detail: st.detail,
			...(st.problem ? { problem: st.problem } : {}),
			...(st.fix ? { fix: st.fix } : {}),
		});
		return st.status;
	};
	const skip = (id: DoctorStep["id"], name: string, why: string) =>
		steps.push({ id, name, status: "skip", ms: 0, detail: [why] });

	const url = (input.mastermindUrl ?? cfg?.mastermindUrl ?? "").replace(
		/\/+$/,
		"",
	);
	const install = url
		? `curl -fsSL ${url}/install.sh | sh`
		: "reinstall the runner";
	let cred = "unknown" as CredentialState;

	// a. config, credential, version
	await timed("a", "config", async (st) => {
		if (!cfg) {
			st.fail(
				`not enrolled (no ${input.configPath})`,
				"mastermind-runner enroll <token> --url <mastermind url>",
			);
			return;
		}
		st.ok(
			`config ${input.configPath}: ${cfg.account}/${s.id}, queues ${s.queues.join(",") || "-"}`,
		);
		if (!s.queues.length)
			st.fail("no queues", "mastermind-runner start --queue <q> --save");
		if (cfg.state === "revoked") {
			st.fail(
				"this runner was revoked",
				"get a new enrol token on /people, then enroll --force",
			);
			return;
		}
		cred = await checkCredential(url, cfg.credential, { fetch: deps.fetch });
		if (cred === "valid") st.ok(`credential valid at ${url}`);
		else if (cred === "revoked")
			st.fail(
				"Mastermind refuses this runner's credential",
				"get a new enrol token on /people, then enroll --force",
			);
		else
			st.fail(
				`Mastermind does not answer at ${url}`,
				"check the network and MASTERMIND_URL",
			);
		for (const p of input.runnerProblems ?? []) st.warn(p.problem, p.fix);
		let server: string | null = null;
		try {
			const res = await (deps.fetch ?? fetch)(`${url}/api/health`, {
				signal: AbortSignal.timeout(10_000),
			});
			server = ((await res.json()) as { version?: string }).version ?? null;
		} catch {}
		if (!server) st.warn("cannot read the server version (/api/health)");
		else if (input.version === "dev")
			st.ok(`server ${server}, runner dev (run from source)`);
		else if (server === input.version) st.ok(`server and runner ${server}`);
		else
			st.warn(
				runnerVersionNotice(input.version, server) ??
					`runner ${input.version} differs from server ${server}`,
				"mastermind-runner update",
			);
	});

	// b. NATS
	if (!cfg || cfg.state === "revoked" || cred === "revoked")
		skip("b", "nats", "skipped: no valid enrolment");
	else
		await timed("b", "nats", async (st) => {
			const natsUrl = input.natsUrl ?? cfg.natsUrl;
			const asyncErrors: string[] = [];
			const t0 = clock();
			let nc: DoctorNats;
			try {
				nc = await (deps.connect ?? connect)({
					servers: natsUrl,
					name: `mastermind-runner doctor ${cfg.account}/${s.id}`,
					token: cfg.credential,
					inboxPrefix: cfg.inboxPrefix,
					timeout: 10_000,
					onStatus: (x) => {
						if (x.type === "error")
							asyncErrors.push(String((x as { error?: unknown }).error));
					},
				});
			} catch (error) {
				if (isAuthFailure(error))
					st.fail(
						`NATS refused the credential at ${natsUrl}`,
						cred === "valid"
							? "Mastermind's auth callout may be down (a NATS restart); try again in a minute"
							: "get a new enrol token on /people, then enroll --force",
					);
				else
					st.fail(
						`cannot connect to NATS at ${natsUrl}: ${error instanceof Error ? error.message : error}`,
						"check the network and MASTERMIND_NATS_URL (wss://...)",
					);
				return;
			}
			const ms = Math.round(clock() - t0);
			try {
				const line = `connected to ${nc.getServer()} in ${ms} ms, credential accepted`;
				if (ms > NATS_SLOW_MS)
					st.warn(
						`${line} (slow: over ${NATS_SLOW_MS} ms)`,
						"check the network path to NATS",
					);
				else st.ok(line);
				// A body without `runner`: Mastermind ignores it, NATS still checks the permission.
				const subject = subjects.runnerStatus(cfg.account, s.id);
				nc.publish(
					subject,
					new TextEncoder().encode(JSON.stringify({ doctor: true })),
				);
				await nc.flush();
				const denied = asyncErrors.find((e) => /permission/i.test(e));
				if (denied)
					st.fail(
						`cannot publish ${subject}: ${denied}`,
						"Mastermind's permissions for this service account are wrong; tell the operator",
					);
				else st.ok(`may publish ${subject}`);
			} finally {
				await nc.close().catch(() => {});
			}
		});

	// Paseo facts, used by c (mode) and d.
	const targetHosts = Object.values(input.routing.targets).map(
		(t) => t.paseoHost,
	);
	const hosts = [...new Set(targetHosts.length ? targetHosts : [undefined])];
	const paseoAt = new Map<
		string | undefined,
		{ daemon: string | null; providers: ProviderInfo[] }
	>();
	for (const h of hosts) {
		const ls = await paseo(["ls", "--json"], h);
		if (ls.code !== 0) {
			paseoAt.set(h, {
				daemon: paseoError(ls),
				providers: [],
			});
			continue;
		}
		const pl = await paseo(["provider", "ls", "--json"], h);
		let providers: ProviderInfo[] = [];
		try {
			providers = pl.code === 0 ? JSON.parse(pl.stdout || "[]") : [];
		} catch {}
		paseoAt.set(h, { daemon: null, providers });
	}
	const available: Record<string, boolean> = {};
	for (const { providers } of paseoAt.values())
		for (const p of providers)
			if (p.provider) available[p.provider] ||= p.status === "available";

	// c. routing
	const decisions: { queue: string; d: Extract<Decision, { ok: true }> }[] = [];
	await timed("c", "routing", (st) => {
		st.ok(`routing ${input.routingSource}`);
		if (!s.queues.length)
			st.fail(
				"no queues to route",
				"mastermind-runner start --queue <q> --save",
			);
		for (const q of s.queues) {
			const d = route(sample(q), input.routing, s.providers, {
				agentProvider: s.agent.provider,
				available,
			});
			if (!d.ok) {
				st.fail(
					`queue ${q}: plain work is declined: ${d.reason}`,
					"fix the routing (mastermind-runner route --queue <q> shows why)",
				);
				continue;
			}
			decisions.push({ queue: q, d });
			const provider = d.agent.provider ?? "none";
			const p0 = provider.split("/")[0] as string;
			const info = paseoAt
				.get(d.host)
				?.providers.find((x) => x.provider === p0);
			const mode = d.agent.mode ?? info?.defaultMode;
			const modeText = d.agent.mode
				? `mode ${d.agent.mode}`
				: `mode not set (Paseo default: ${info?.defaultMode ?? "unknown"})`;
			st.ok(
				`queue ${q}: target ${d.target} on ${d.host ?? "local"}, provider ${provider}, ${modeText} (rule ${d.rule})`,
			);
			st.ok(
				`  ${paseoCommandLine({ title: "<title>", cwd: d.binding?.dir ?? s.workdir ?? "<repo checkout>", agent: d.agent, labels: d.labels, host: d.host })}`,
			);
			const fixMode = `mastermind-runner start --mode ${UNATTENDED_MODE[p0] ?? "<a mode that does not ask>"} --save (or set mode on the target or rule)`;
			if (mode && asksPermission(provider, mode))
				st.warn(
					`queue ${q}: mode ${mode} of ${p0} asks for permission: an unattended agent waits forever`,
					fixMode,
				);
			else if (!mode && ASKING_MODES[p0])
				st.warn(
					`queue ${q}: no mode set and Paseo does not say its default: the agent may ask for permission`,
					fixMode,
				);
		}
	});

	// d. Paseo
	await timed("d", "paseo", async (st) => {
		for (const [h, info] of paseoAt) {
			const where = h ?? "local";
			if (info.daemon) {
				st.fail(
					`Paseo daemon on ${where} does not answer: ${info.daemon}`,
					h
						? `check --paseo-host / targets paseoHost ${h}`
						: "start it: paseo daemon start",
				);
				continue;
			}
			st.ok(`Paseo daemon on ${where} answers`);
		}
		const seen = new Set<string>();
		for (const { d } of decisions) {
			const p = (d.agent.provider ?? "").split("/")[0] as string;
			const key = `${d.host ?? ""}|${p}`;
			if (!p || seen.has(key)) continue;
			seen.add(key);
			const info = paseoAt.get(d.host);
			if (!info || info.daemon) continue;
			const x = info.providers.find((y) => y.provider === p);
			if (x?.status === "available")
				st.ok(
					`provider ${p} available on ${d.host ?? "local"} (default mode ${x.defaultMode ?? "-"})`,
				);
			else
				st.fail(
					`provider ${p} is ${x ? x.status : "not listed"} on ${d.host ?? "local"}`,
					`log in to ${p} on that machine, then check: paseo provider ls`,
				);
		}
		if (s.workdir) {
			if (isDir(s.workdir)) st.ok(`workdir ${s.workdir} exists`);
			else
				st.fail(
					`workdir ${s.workdir} does not exist`,
					"create it, or --workdir <dir> --save",
				);
		}
		for (const [repo, dir] of Object.entries(s.repos)) {
			if (await isGit(dir)) st.ok(`repo ${repo}: ${dir} is a git checkout`);
			else
				st.fail(
					`repo ${repo}: ${dir} is not a git checkout`,
					`git clone ${repo} ${dir}`,
				);
		}
		for (const [name, b] of Object.entries(input.routing.environments)) {
			if (!isDir(b.dir))
				st.fail(
					`environment ${name}: ${b.dir} does not exist`,
					"clone it there, or fix routing.json",
				);
			else if (await isGit(b.dir))
				st.ok(`environment ${name}: ${b.dir} is a git checkout`);
			else st.warn(`environment ${name}: ${b.dir} is not a git checkout`);
		}
	});

	// e. a real agent
	const first = decisions[0];
	if (!input.deep)
		skip("e", "agent", "skipped: run doctor --deep to start a real agent");
	else if (!first)
		skip("e", "agent", "skipped: no queue routes plain work to a target");
	else
		await timed("e", "agent", async (st) => {
			const { d } = first;
			const cwd = d.binding?.dir ?? s.workdir ?? process.cwd();
			const executionId = `doctor-${(deps.now?.() ?? new Date()).getTime()}`;
			const launcher = deps.launcher ?? new PaseoLauncher();
			const labels = {
				...d.labels,
				purpose: "probe",
				"mastermind.doctor": "1",
			};
			const spec: AgentSpec = {
				executionId,
				beadId: "doctor",
				title: `probe: mastermind doctor ${s.id}`,
				cwd,
				prompt: PROBE_PROMPT,
				agent: d.agent,
				labels,
				...(d.host ? { host: d.host } : {}),
			};
			st.ok(`queue ${first.queue}: ${paseoCommandLine({ ...spec, labels })}`);
			const timeout = input.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
			const stop = new AbortController();
			const timer = setTimeout(() => stop.abort(), timeout);
			try {
				const r = await launcher.run(spec, stop.signal);
				if (r.status === "done" && /^\W*ok\W*$/i.test(r.summary.trim()))
					st.ok(`agent answered: ${r.summary.trim()}`);
				else
					st.warn(
						`agent answered ${r.status}: ${r.summary.slice(0, 200)}`,
						"the agent runs but does not follow the prompt; check the provider and model",
					);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				const p0 = (d.agent.provider ?? "").split("/")[0] as string;
				const login = !stop.signal.aborted && providerLoginMessage(msg);
				st.fail(
					stop.signal.aborted
						? `no answer within ${timeout / 1000} s`
						: (login ? (msg.split("; fix: ")[0] ?? msg) : msg).slice(0, 600),
					login
						? PROVIDER_LOGIN_FIX
						: /permission/i.test(msg)
							? `the agent waits for permission: mastermind-runner start --mode ${UNATTENDED_MODE[p0] ?? "<a mode that does not ask>"} --save`
							: /MISSING_PROVIDER/.test(msg)
								? `update the runner: ${install}`
								: "run the command above by hand to see the Paseo error",
				);
			} finally {
				clearTimeout(timer);
				const ids = await launcher
					.find(executionId, d.host)
					.catch(() => [] as string[]);
				for (const id of ids) {
					const res = await paseo(["archive", "--force", id], d.host);
					if (res.code === 0) st.ok(`probe agent ${id} archived`);
					else
						st.warn(
							`cannot archive probe agent ${id}: ${paseoError(res)}`,
							`paseo archive --force ${id}`,
						);
				}
			}
		});

	// f. secrets: names only
	const secrets = input.secrets;
	if (secrets)
		await timed("f", "secrets", async (st) => {
			const x = await secrets();
			if (!x.needs)
				st.fail(
					x.problem ?? "the needed secrets are unknown",
					"check the network and MASTERMIND_URL, then: mastermind-runner secrets check",
				);
			else if (x.problem) st.warn(x.problem, "mastermind-runner secrets check");
			for (const r of x.rows.filter((r) => r.neededBy.length)) {
				if (r.present)
					st.ok(
						`${r.name}: present (${r.from}), needed by ${r.neededBy.join(",")}`,
					);
				else
					st.fail(
						`${r.name}: MISSING, needed by ${r.neededBy.join(",")}; fix: mastermind-runner secrets set ${r.name}`,
						`mastermind-runner secrets set ${r.name}`,
					);
			}
			if (x.needs && !x.diagnostics.needed.length)
				st.ok("no environment this runner can get needs a secret");
		});

	// g. box
	const box = input.box;
	if (box?.noBox)
		skip(
			"g",
			"box",
			"skipped: the runner runs with --no-box (agents run on this machine, owner's risk)",
		);
	else if (box)
		await timed("g", "box", async (st) => {
			const { driver } = box;
			const ms = (t0: number) => Math.round(clock() - t0);
			const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
			let t0 = clock();
			try {
				const engine = await driver.ping();
				st.ok(`engine ${driver.name} answers: ${engine} (${ms(t0)} ms)`);
				// gVisor for environments with runtime gvisor (mm-210.63): a fact, not a failure.
				const runtimes = await driver.runtimes?.().catch(() => undefined);
				if (runtimes)
					st.ok(
						`runtimes: ${runtimes.join(", ") || "none"}; gVisor (runsc) ${runtimes.includes(ENGINE_RUNTIME.gvisor) ? "available" : "not installed: environments with runtime gvisor are not ready here"}`,
					);
			} catch (error) {
				// The driver's message may carry its own '; fix: ...'.
				st.fail(
					`engine ${driver.name} does not answer: ${msg(error).split("; fix: ")[0]}`,
					NO_BOX_FIX,
				);
				return;
			}
			t0 = clock();
			let image: string;
			try {
				image = await driver.ensureImage({ image: box.image });
				st.ok(`default image ${box.image} present (${ms(t0)} ms)`);
			} catch (error) {
				st.fail(
					`default image ${box.image} is not present and cannot be pulled: ${msg(error).slice(0, 400)}`,
					"check the image name and the registry login, or --box-image <ref> / MASTERMIND_BOX_IMAGE",
				);
				return;
			}
			if (!input.deep) {
				st.ok("doctor --deep also makes a box and starts the agent host in it");
				return;
			}
			const executionId = `doctor-${(deps.now?.() ?? new Date()).getTime()}`;
			let b: Box | undefined;
			try {
				t0 = clock();
				try {
					b = await driver.create({
						image,
						name: `mm-box-${executionId}`,
						labels: {
							[BOX_LABEL.runner]: s.id,
							[BOX_LABEL.item]: "doctor",
							[BOX_LABEL.execution]: executionId,
						},
						network: "open",
						env: { ...BOX_ENV },
					});
				} catch (error) {
					st.fail(
						`cannot make a box from ${image}: ${msg(error).slice(0, 400)}`,
						"check the engine (disk, rootless Podman setup); the runner log has the engine error",
					);
					return;
				}
				st.ok(`box ${b.name} made in ${ms(t0)} ms`);
				// The agent host runs as `paseo` when the image has that user (as in run.ts).
				const p = await b.exec(["id", "-u", "paseo"], {
					user: "root",
					workdir: "/",
				});
				const user = p.code === 0 ? { user: "paseo" } : {};
				t0 = clock();
				const timeout = input.boxReadyTimeoutMs ?? BOX_READY_TIMEOUT_MS;
				const sleep = deps.sleep ?? ((n: number) => Bun.sleep(n));
				for (;;) {
					const r = await b.exec(["paseo", "status", "--json"], {
						workdir: "/",
						...user,
					});
					if (r.code === 0) {
						st.ok(`paseo status --json in the box answers in ${ms(t0)} ms`);
						break;
					}
					if (clock() - t0 > timeout) {
						const logs = await b.logs(10).catch(() => "");
						st.fail(
							`the agent host in the box does not answer within ${timeout / 1000} s: ${paseoError(r)}${logs ? ` | box log: ${logs.replace(/\s+/g, " ").trim().slice(-300)}` : ""}`,
							`the image must start the Paseo daemon (default image: ${DEFAULT_BOX_IMAGE}); check --box-image / MASTERMIND_BOX_IMAGE`,
						);
						break;
					}
					await sleep(500);
				}
			} finally {
				if (b) {
					t0 = clock();
					try {
						await b.destroy();
						st.ok(`box ${b.name} deleted in ${ms(t0)} ms`);
					} catch (error) {
						st.warn(
							`cannot delete box ${b.name}: ${msg(error)}`,
							`the next runner start deletes it; or: docker rm -f ${b.name}`,
						);
					}
				}
			}
		});

	// h. model credential: accepted by Anthropic, with the box proxy's header
	const model = input.model;
	if (model)
		await timed("h", "model credential", async (st) => {
			const m = await model();
			if (!m) {
				st.ok(
					"no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY on this machine (step f says if an environment needs one)",
				);
				return;
			}
			const c = await checkModelSecret(
				m.secret,
				m.value,
				deps.fetch,
				input.modelUpstream,
			);
			const line = `${m.secret} (${m.from}) at Anthropic: ${modelCheckText(c)} (GET /v1/models with the box proxy's header)`;
			if (c.result === "accepted") st.ok(line);
			else if (c.result === "refused")
				st.fail(line, modelCredentialFix(m.secret));
			else st.warn(line, "check the network to api.anthropic.com");
		});

	return {
		runner: s.id,
		at: (deps.now?.() ?? new Date()).toISOString(),
		deep: input.deep,
		ok: steps.every((x) => x.status !== "fail"),
		steps,
	};
}

const MARK: Record<StepStatus, string> = {
	pass: "PASS",
	warn: "WARN",
	fail: "FAIL",
	skip: "SKIP",
};

/** The report as text, one block per step. */
export function formatReport(r: DoctorReport): string[] {
	const out: string[] = [];
	for (const s of r.steps) {
		out.push(`${MARK[s.status]} ${s.id}. ${s.name} (${s.ms} ms)`);
		for (const l of s.detail) out.push(`     ${l}`);
		if (s.fix && (s.status === "warn" || s.status === "fail"))
			out.push(`     fix: ${s.fix}`);
	}
	const bad = r.steps.filter((s) => s.status === "fail").length;
	const warn = r.steps.filter((s) => s.status === "warn").length;
	out.push(
		bad
			? `runner ${r.runner}: ${bad} step(s) FAIL${warn ? `, ${warn} WARN` : ""}`
			: `runner ${r.runner}: no failure${warn ? ` (${warn} WARN)` : ""}${r.deep ? "" : "; doctor --deep also starts a real agent and a box"}`,
	);
	return out;
}
