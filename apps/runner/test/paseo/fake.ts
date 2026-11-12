// A fake Paseo daemon behind the real adapter (src/paseo/client.ts): the
// SDK calls the runner makes, in memory. The prompt steers an agent like the
// old CLI fake did: FAKE:fail, FAKE:slow, FAKE:crash, FAKE:garbage,
// FAKE:nologin. A claude agent in a mode that asks waits for permission.
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	type Paseo,
	type PaseoConnect,
	PaseoUnreachable,
	paseoOver,
} from "../../src/paseo/client.ts";
import type { DaemonClient } from "../../src/paseo/connect.ts";

export type FakeAgent = {
	id: string;
	provider: string;
	model?: string;
	modeId?: string;
	cwd: string;
	title: string;
	prompt: string;
	labels: Record<string, string>;
	env?: Record<string, string>;
	/** What the agent found at MASTERMIND_ENV_FILE while it ran. */
	envFile: { path: string; text: string; mode: number; dirMode: number } | null;
	archived: boolean;
	cancelled: boolean;
	host: string | undefined;
	answers: string[];
};

export type FakeProvider = {
	provider: string;
	status?: "ready" | "loading" | "error" | "unavailable";
	defaultModeId?: string | null;
	modes?: string[];
	models?: string[];
	enabled?: boolean;
	error?: string;
	/** Paseo's diagnostic text; default: a logged-in Claude Code block. */
	diagnostic?: string;
};

export const LOGGED_IN = `Claude Code
  Binary: claude
  Auth: {
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}
  Models: 20
  Status: Ready`;

export const NOT_LOGGED_IN = `Claude Code
  Binary: claude
  Auth: {
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}
  Models: 0
  Status: Ready`;

const ASKING = ["default", "plan", "acceptEdits", undefined];

export class FakePaseo {
	agents: FakeAgent[] = [];
	/** Every adapter call: [host, method, ...args]. */
	calls: { host: string | undefined; op: string; arg?: unknown }[] = [];
	providers: FakeProvider[] = [
		{
			provider: "claude",
			status: "ready",
			defaultModeId: "auto",
			modes: ["default", "auto", "bypassPermissions"],
		},
	];
	hosts: {
		registrationId: string;
		label: string | null;
		metadata: Record<string, string>;
		connection: string;
		status?: string;
	}[] = [];
	/** Hosts whose daemon does not answer. */
	down = new Set<string | undefined>();
	open = 0;

	/** The connect function to give to the runner. */
	readonly connect: PaseoConnect = async (host) => {
		this.calls.push({ host, op: "connect" });
		if (this.down.has(host))
			throw new PaseoUnreachable(
				`the Paseo daemon at ${host ?? "local"} does not answer: connect ECONNREFUSED`,
				"start it: paseo daemon start",
			);
		this.open++;
		const p = paseoOver(this.client(host), host ?? "local");
		return { ...p, close: async () => void this.open-- } satisfies Paseo;
	};

	ops(op: string) {
		return this.calls.filter((c) => c.op === op);
	}

	client(host: string | undefined): DaemonClient {
		const log = (op: string, arg?: unknown) =>
			this.calls.push({ host, op, arg });
		const find = (id: string) => {
			const a = this.agents.find((x) => x.id === id);
			if (!a) throw new Error(`no agent ${id}`);
			return a;
		};
		const c = {
			getProvidersSnapshot: async () => {
				log("providers");
				return {
					entries: this.providers.map((p) => ({
						provider: p.provider,
						status: p.status ?? "ready",
						enabled: p.enabled ?? true,
						defaultModeId: p.defaultModeId ?? null,
						modes: (p.modes ?? []).map((id) => ({ id, label: id })),
						...(p.models
							? { models: p.models.map((id) => ({ id, label: id })) }
							: {}),
						...(p.error ? { error: p.error } : {}),
					})),
				};
			},
			getProviderDiagnostic: async (provider: string) => {
				log("diagnostic", provider);
				const p = this.providers.find((x) => x.provider === provider);
				return { provider, diagnostic: p?.diagnostic ?? LOGGED_IN };
			},
			fetchAgents: async (o: {
				filter?: { labels?: Record<string, string> };
			}) => {
				log("fetchAgents", o.filter?.labels);
				const want = o.filter?.labels ?? {};
				return {
					entries: this.agents
						.filter((a) => a.host === host)
						.filter((a) =>
							Object.entries(want).every(([k, v]) => a.labels[k] === v),
						)
						.map((a) => ({ agent: { id: a.id, labels: a.labels } })),
					pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
				};
			},
			createWorkspace: async (o: { source: { path: string } }) => {
				log("createWorkspace", o.source.path);
				return {
					workspace: { id: "wks_fake", workspaceDirectory: o.source.path },
					error: null,
				};
			},
			createAgent: async (o: {
				provider: string;
				model?: string;
				modeId?: string;
				cwd: string;
				title: string;
				initialPrompt: string;
				labels: Record<string, string>;
				env?: Record<string, string>;
			}) => {
				log("createAgent", o);
				if (!o.provider) throw new Error("Provider is required");
				const f = o.env?.MASTERMIND_ENV_FILE;
				let envFile: FakeAgent["envFile"] = null;
				try {
					if (f)
						envFile = {
							path: f,
							text: readFileSync(f, "utf8"),
							mode: statSync(f).mode & 0o777,
							dirMode: statSync(dirname(f)).mode & 0o777,
						};
				} catch {}
				const a: FakeAgent = {
					id: `agent-${this.agents.length + 1}`,
					provider: o.provider,
					...(o.model ? { model: o.model } : {}),
					...(o.modeId ? { modeId: o.modeId } : {}),
					cwd: o.cwd,
					title: o.title,
					prompt: o.initialPrompt,
					labels: o.labels,
					...(o.env ? { env: o.env } : {}),
					envFile,
					archived: false,
					cancelled: false,
					host,
					answers: [],
				};
				this.agents.push(a);
				return { id: a.id };
			},
			waitForFinish: async (id: string) => {
				log("waitForFinish", id);
				const a = find(id);
				if (a.prompt.includes("FAKE:crash"))
					return {
						status: "error",
						final: null,
						error: "daemon connection closed",
						lastMessage: null,
					};
				if (a.provider === "claude" && ASKING.includes(a.modeId))
					return {
						status: "permission",
						final: null,
						error: null,
						lastMessage: null,
					};
				if (a.prompt.includes("FAKE:slow"))
					for (let i = 0; i < 600 && !a.cancelled; i++) await Bun.sleep(100);
				if (a.cancelled)
					return {
						status: "idle",
						final: null,
						error: null,
						lastMessage: null,
					};
				let text: string;
				if (a.prompt.includes("FAKE:nologin"))
					text = "Not logged in · Please run /login";
				else if (a.prompt.includes("FAKE:garbage")) text = "hello there";
				else {
					const failed = a.prompt.includes("FAKE:fail");
					text = JSON.stringify({
						status: failed ? "failed" : "done",
						summary: failed
							? "could not do it"
							: `did: ${a.prompt.split("\n")[0]}`,
					});
				}
				a.answers.push(text);
				return { status: "idle", final: null, error: null, lastMessage: text };
			},
			sendMessage: async (id: string, text: string) => {
				log("sendMessage", { id, text });
			},
			fetchAgentTimeline: async () => ({ entries: [] }),
			cancelAgent: async (id: string) => {
				log("cancelAgent", id);
				find(id).cancelled = true;
			},
			archiveAgent: async (id: string) => {
				log("archiveAgent", id);
				const a = this.agents.find((x) => x.id === id);
				if (a) a.archived = true;
				return { archivedAt: new Date().toISOString() };
			},
			listHosts: async () => {
				log("listHosts");
				return {
					self: { serverId: "srv", label: "me" },
					hosts: this.hosts.map((h) => ({ status: "online", ...h })),
				};
			},
			addHost: async (h: {
				connection: string;
				label: string;
				metadata: Record<string, string>;
			}) => {
				log("addHost", h);
				const row = {
					registrationId: `reg-${this.hosts.length + 1}`,
					label: h.label,
					metadata: h.metadata,
					connection: h.connection,
					status: "online",
				};
				this.hosts.push(row);
				return row;
			},
			removeHost: async (id: string) => {
				log("removeHost", id);
				this.hosts = this.hosts.filter((h) => h.registrationId !== id);
			},
			close: async () => {},
		};
		return c as unknown as DaemonClient;
	}
}
