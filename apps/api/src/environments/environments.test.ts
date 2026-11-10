import { describe, expect, test } from "bun:test";
import { BusError, type StoreEntry } from "@mastermind/bus";
import { ENVIRONMENTS_KEY, resolveEnv, validate } from "./model.ts";
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

describe("validate", () => {
	test("a good document passes; lists default to empty, ref to main", () => {
		const v = validate({
			environments: [SCRATCH, { name: "min", repo: "git@host:a/b.git" }],
		});
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.doc.environments[0]).toEqual(SCRATCH);
		expect(v.doc.environments[1]).toEqual({
			name: "min",
			description: "",
			repo: "git@host:a/b.git",
			ref: "main",
			requires: [],
			setup: [],
			check: [],
			secrets: [],
		});
	});

	test("errors are tied to fields", () => {
		const v = validate({
			environments: [
				{ name: "a.b", repo: "" },
				{ name: "ok", repo: "x", setup: ["", 3], secrets: ["NOT OK"] },
				{ name: "ok", repo: "x y", agent: { mode: "two words" } },
			],
		});
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
});

describe("resolveEnv", () => {
	const doc = { environments: [validateOk(SCRATCH)] };

	test("env:<name> resolves to the definition; ref: and req: labels add to it", () => {
		const r = resolveEnv(
			{ labels: ["env:scratch", "ref:feat-x", "req:docker", "req:bun>=1.4"] },
			doc,
		);
		expect(r).toEqual({
			ok: true,
			env: {
				name: "scratch",
				repo: SCRATCH.repo,
				ref: "feat-x",
				requires: ["bun>=1.4", "docker"],
				setup: ["bun install"],
				check: ["bun test"],
				secrets: ["GH_TOKEN"],
				agent: { provider: "claude" },
				instructions: "Keep commits small.",
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
	const v = validate({ environments: [e] });
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
