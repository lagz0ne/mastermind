import { describe, expect, test } from "bun:test";
import { BusError, type StoreEntry } from "@mastermind/bus";
import { ENVIRONMENTS_KEY, recipeHash, resolveEnv, validate } from "./model.ts";
import { environmentRoutes } from "./routes.ts";
import {
	EnvironmentStore,
	type EnvironmentsKv,
	StaleEnvironments,
} from "./store.ts";

/** In-memory KV with JetStream's compare-and-set rules. */
function memoryKv(): EnvironmentsKv {
	const map = new Map<string, { value: unknown; revision: number }>();
	let seq = 0;
	return {
		async get(key) {
			const e = map.get(key);
			return e ? ({ key, ...structuredClone(e) } as StoreEntry<unknown>) : null;
		},
		async create(key, value) {
			if (map.has(key)) throw new BusError("conflict", "exists");
			map.set(key, { value: structuredClone(value), revision: ++seq });
			return seq;
		},
		async update(key, value, revision) {
			if (map.get(key)?.revision !== revision)
				throw new BusError("conflict", "wrong last sequence");
			map.set(key, { value: structuredClone(value), revision: ++seq });
			return seq;
		},
	};
}

const SCRATCH = {
	name: "scratch",
	description: "a throwaway repo",
	repo: "https://github.com/acme/scratch.git",
	ref: "main",
	requires: ["bun>=1.4"],
	setup: ["bun install"],
	check: ["bun test"],
	secrets: ["GH_TOKEN"],
	agent: { provider: "claude" },
	instructions: "Keep commits small.",
};

/** A full box recipe: every field set. */
const BOX = {
	name: "box",
	description: "every field",
	image: "ghcr.io/acme/box:1",
	tools: ["RUN apt-get install -y jq"],
	setup: ["bun install"],
	check: ["bun test"],
	limits: { cpu: 1.5, memoryMb: 2048, timeoutMin: 30 },
	network: { allow: ["github.com", "*.npmjs.org", "registry.local:5000"] },
	repo: "https://github.com/acme/box.git",
	ref: "dev",
	requires: ["docker"],
	secrets: ["GH_TOKEN"],
	provider: { name: "claude", auth: "CLAUDE_TOKEN" },
	agent: { mode: "bypass" },
	output: { kind: "pr" as const, base: "main" },
	instructions: "Small commits.",
};

describe("validate", () => {
	test("an environment saved before box recipes loads with defaults", () => {
		const v = validate(
			{ environments: [SCRATCH, { name: "min", repo: "git@host:a/b.git" }] },
			"ghcr.io/acme/default:1",
		);
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.doc.environments[0]).toEqual({
			...SCRATCH,
			image: "ghcr.io/acme/default:1",
			tools: [],
			limits: { cpu: 2, memoryMb: 4096, timeoutMin: 60 },
			network: "open",
			output: { kind: "none" },
			// The old preference becomes the provider.
			provider: { name: "claude" },
		});
		expect(v.doc.environments[1]).toEqual({
			name: "min",
			description: "",
			image: "ghcr.io/acme/default:1",
			tools: [],
			setup: [],
			check: [],
			limits: { cpu: 2, memoryMb: 4096, timeoutMin: 60 },
			network: "open",
			repo: "git@host:a/b.git",
			ref: "main",
			requires: [],
			secrets: [],
			output: { kind: "none" },
		});
	});

	test("a full recipe round-trips; no default image config leaves image empty", () => {
		const v = validate({ environments: [BOX] }, "");
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.doc.environments[0]).toEqual(BOX);
		const none = validate({ environments: [{ name: "x", repo: "r" }] }, "");
		expect(none.ok && none.doc.environments[0]?.image).toBe("");
	});

	test("errors are tied to fields", () => {
		const v = validate(
			{
				environments: [
					{ name: "a.b", repo: "" },
					{ name: "ok", repo: "x", setup: ["", 3], secrets: ["NOT OK"] },
					{ name: "ok", repo: "x y", agent: { mode: "two words" } },
				],
			},
			"",
		);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.errors.map((e) => e.field)).toEqual([
			"environments.0.name",
			"environments.0.repo",
			"environments.1.setup.0",
			"environments.1.setup.1",
			"environments.1.secrets.0",
			"environments.2.name",
			"environments.2.repo",
			"environments.2.agent.mode",
		]);
	});

	test("box fields: limits, network, provider, output and image are checked by field", () => {
		const v = validate(
			{
				environments: [
					{
						name: "b",
						repo: "",
						image: "two words",
						limits: { cpu: 0, memoryMb: 100.5, timeoutMin: 2000 },
						network: { allow: ["ok.com", "not a host"] },
						provider: { name: "", auth: "bad-name" },
						output: { kind: "pr", base: "a b" },
					},
					{ name: "c", repo: "r", network: "closed", output: { kind: "zip" } },
				],
			},
			"",
		);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.errors.map((e) => e.field)).toEqual([
			"environments.0.repo",
			"environments.0.image",
			"environments.0.limits.cpu",
			"environments.0.limits.memoryMb",
			"environments.0.limits.timeoutMin",
			"environments.0.network.allow.1",
			"environments.0.output.base",
			"environments.0.output.kind",
			"environments.0.provider.name",
			"environments.0.provider.auth",
			"environments.1.network",
			"environments.1.output.kind",
		]);
	});
});

describe("devcontainer settings (mm-210.62)", () => {
	const base = { name: "dc", repo: "https://github.com/acme/dc.git" };
	test("own config (JSONC), configPath, use and allowHost are kept; resolveEnv passes them", () => {
		const config = '// own\n{"image": "debian", "postCreateCommand": "make",}';
		const v = validate(
			{
				environments: [
					{
						...base,
						devcontainer: {
							config,
							configPath: "python",
							allowHost: ["initializeCommand"],
							use: "auto",
						},
					},
					{ ...base, name: "off", devcontainer: { use: "none" } },
					{ ...base, name: "empty", devcontainer: { config: "", use: "auto" } },
				],
			},
			"",
		);
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		const [dc, off, empty] = v.doc.environments;
		expect(dc?.devcontainer).toEqual({
			config,
			configPath: "python",
			allowHost: ["initializeCommand"],
		});
		expect(off?.devcontainer).toEqual({ use: "none" });
		expect(empty?.devcontainer).toBeUndefined();
		const r = resolveEnv({ labels: ["env:dc"] }, v.doc);
		expect(r.ok && r.env.devcontainer).toEqual(dc?.devcontainer ?? {});
	});
	test("bad settings are errors by field", () => {
		const v = validate(
			{
				environments: [
					{
						...base,
						devcontainer: {
							use: "always",
							config: "{ not json",
							configPath: "../etc",
							allowHost: ["runArgs"],
						},
					},
					{
						...base,
						name: "c1",
						devcontainer: { config: '{"dockerComposeFile": "x.yml"}' },
					},
					{
						...base,
						name: "c2",
						devcontainer: { config: '{"name": "no image"}' },
					},
					{ ...base, name: "c3", devcontainer: "yes" },
				],
			},
			"",
		);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.errors.map((e) => e.field)).toEqual([
			"environments.0.devcontainer.use",
			"environments.0.devcontainer.config",
			"environments.0.devcontainer.configPath",
			"environments.0.devcontainer.allowHost.0",
			"environments.1.devcontainer.config",
			"environments.2.devcontainer.config",
			"environments.3.devcontainer",
		]);
		expect(v.errors[4]?.message).toContain("Docker Compose is not supported");
	});
});

describe("recipeHash", () => {
	test("stable for image + tools; any change in them changes it; other fields do not", () => {
		const h = recipeHash(BOX);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		const otherSetup = {
			...BOX,
			setup: ["other"],
			limits: { cpu: 9, memoryMb: 9999, timeoutMin: 9 },
		};
		expect(recipeHash(otherSetup)).toBe(h);
		expect(recipeHash({ ...BOX, tools: [...BOX.tools, "RUN true"] })).not.toBe(
			h,
		);
		expect(recipeHash({ ...BOX, image: "ghcr.io/acme/box:2" })).not.toBe(h);
	});
});

describe("resolveEnv", () => {
	const doc = { environments: [validateOk(SCRATCH), validateOk(BOX)] };

	test("env:<name> resolves to the definition; ref: and req: labels add to it", () => {
		const r = resolveEnv(
			{ labels: ["env:scratch", "ref:feat-x", "req:docker", "req:bun>=1.4"] },
			doc,
		);
		expect(r.ok && r.env).toMatchObject({
			name: "scratch",
			repo: SCRATCH.repo,
			ref: "feat-x",
			requires: ["bun>=1.4", "docker"],
			setup: ["bun install"],
			check: ["bun test"],
			secrets: ["GH_TOKEN"],
			agent: { provider: "claude" },
			instructions: "Keep commits small.",
		});
	});

	test("the envelope carries the whole recipe with its hash; the provider login is a needed secret", () => {
		const r = resolveEnv({ labels: ["env:box"] }, doc);
		expect(r).toEqual({
			ok: true,
			env: {
				name: "box",
				repo: BOX.repo,
				ref: "dev",
				requires: ["docker"],
				setup: ["bun install"],
				check: ["bun test"],
				secrets: ["GH_TOKEN", "CLAUDE_TOKEN"],
				image: BOX.image,
				tools: BOX.tools,
				recipeHash: recipeHash(BOX),
				limits: BOX.limits,
				network: BOX.network,
				output: BOX.output,
				providerLogin: { name: "claude", auth: "CLAUDE_TOKEN" },
				agent: { mode: "bypass", provider: "claude" },
				instructions: "Small commits.",
			},
		});
	});

	test("the label wins over the routing default; the default applies without a label", () => {
		expect(resolveEnv({ labels: [] }, doc, { fallback: "scratch" }).ok).toBe(
			true,
		);
		const r = resolveEnv({ labels: ["env:other"] }, doc, {
			fallback: "scratch",
		});
		expect(r).toEqual({
			ok: false,
			reason: "environment other is not defined (see /environments)",
		});
	});

	test("old repo: labels still dispatch; nothing at all does not", () => {
		const old = resolveEnv({ labels: ["repo:https://x/y.git"] }, doc);
		expect(old).toEqual({
			ok: true,
			env: { repo: "https://x/y.git", ref: "main", requires: [] },
		});
		expect(resolveEnv({ labels: ["queue:a"] }, doc).ok).toBe(false);
		// Before the first save, a bead without a name dispatches as before.
		expect(resolveEnv({ labels: ["queue:a"] }, doc, { open: true })).toEqual({
			ok: true,
			env: { repo: "", ref: "main", requires: [] },
		});
	});
});

function validateOk(e: unknown) {
	const v = validate({ environments: [e] }, "");
	if (!v.ok) throw new Error(JSON.stringify(v.errors));
	return v.doc.environments[0] as NonNullable<
		(typeof v.doc.environments)[number]
	>;
}

describe("store", () => {
	test("compare-and-set: a stale revision throws with the current state", async () => {
		const store = new EnvironmentStore(memoryKv());
		expect(await store.read()).toEqual({
			doc: { environments: [] },
			revision: 0,
		});
		const doc = { environments: [validateOk(SCRATCH)] };
		const first = await store.write(doc, 0);
		expect(first.revision).toBe(1);
		const err = await store.write(doc, 0).catch((e) => e);
		expect(err).toBeInstanceOf(StaleEnvironments);
		expect((err as StaleEnvironments).current.revision).toBe(1);
		expect(ENVIRONMENTS_KEY).toBe("environments");
	});
});

describe("routes", () => {
	const setup = (account: string | null = "alice") => {
		const store = new EnvironmentStore(memoryKv());
		const routes = environmentRoutes({
			store: () => store,
			requireAccount: async () =>
				account ?? Response.json({ error: "login" }, { status: 401 }),
		})["/api/environments"];
		const put = (b: unknown) =>
			routes.PUT(
				new Request("http://x/api/environments", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(b),
				}),
			);
		return { routes, put };
	};

	test("two saves at the same revision: the second gets 409 with the current", async () => {
		const { routes, put } = setup();
		const a = await put({ environments: [SCRATCH], revision: 0 });
		expect(a.status).toBe(200);
		expect(((await a.json()) as { revision: number }).revision).toBe(1);
		const b = await put({ environments: [], revision: 0 });
		expect(b.status).toBe(409);
		// biome-ignore lint/suspicious/noExplicitAny: test body
		const body: any = await b.json();
		expect(body.current.revision).toBe(1);
		expect(body.current.environments[0].name).toBe("scratch");
		const got = (await (
			await routes.GET(new Request("http://x/api/environments"))
		).json()) as { environments: unknown[] };
		expect(got.environments).toHaveLength(1);
	});

	test("bad input: 400 with errors by field", async () => {
		const { put } = setup();
		const r = await put({ environments: [{ name: "x" }], revision: 0 });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { errors: unknown }).errors).toEqual([
			{ field: "environments.0.repo", message: "required" },
		]);
	});

	test("no session: the auth answer", async () => {
		const { put } = setup(null);
		expect((await put({ environments: [], revision: 0 })).status).toBe(401);
	});
});
