import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AccountsReply,
	Me,
	NextRequest,
	PeopleSetup,
	RunnersReply,
} from "@mastermind/core";
import { MemoryKv } from "../auth/memory-kv.ts";
import { Auth } from "../auth/service.ts";
import { accountGuard, type RequireAccount } from "../auth/session.ts";
import { inviteAs, loginAs } from "../auth/test-login.ts";
import { Dispatcher } from "../dispatch/dispatcher.ts";
import { fakeWork } from "../dispatch/fake-work.ts";
import { RunnerRegistry } from "./registry.ts";
import { joinRunners, peopleRoutes } from "./routes.ts";
import { runnerScript } from "./runner-script.ts";

const T0 = Date.parse("2026-11-10T08:00:00Z");

function clock() {
	let t = T0;
	return {
		now: () => new Date(t),
		advance: (ms: number) => {
			t += ms;
		},
	};
}

const info = (id: string, sa: string, extra = {}): NextRequest => ({
	runner: {
		id,
		account: "alice",
		serviceAccount: sa,
		providers: ["claude"],
		capabilities: ["git"],
		...extra,
	},
});

describe("registry", () => {
	test("a next request registers the runner with its queues and capacity", () => {
		const c = clock();
		const r = new RunnerRegistry({ now: c.now });
		let changes = 0;
		r.subscribe(() => changes++);
		r.observe({
			kind: "next",
			queue: "build",
			runner: info("laptop", "sa1", { capacity: 2, queues: ["build", "fix"] })
				.runner,
		});
		expect(r.list()).toEqual([
			{
				account: "alice",
				runner: "laptop",
				serviceAccount: "sa1",
				queues: ["build", "fix"],
				capabilities: ["git"],
				providers: ["claude"],
				capacity: 2,
				version: null,
				running: [],
				lastSeenAt: "2026-11-10T08:00:00.000Z",
				online: true,
			},
		]);
		expect(changes).toBe(1);
	});

	test("holds and done track the running beads; online expires; forget drops", () => {
		const c = clock();
		const r = new RunnerRegistry({ now: c.now, onlineMs: 90_000 });
		r.observe({ kind: "next", queue: "q", runner: info("a", "sa1").runner });
		r.observe({ kind: "holds", actor: "alice/a", beadId: "mm-2" });
		r.observe({ kind: "holds", actor: "alice/a", beadId: "mm-1" });
		expect(r.list()[0]?.running).toEqual(["mm-1", "mm-2"]);
		c.advance(60_000);
		// A sweep's done is not a sign of life.
		r.observe({ kind: "done", actor: "alice/a", beadId: "mm-2" });
		expect(r.list()[0]?.running).toEqual(["mm-1"]);
		expect(r.list()[0]?.lastSeenAt).toBe("2026-11-10T08:00:00.000Z");
		c.advance(31_000);
		expect(r.list()[0]?.online).toBe(false);
		// Actors that are not account/runner are ignored.
		r.observe({ kind: "holds", actor: "rocky", beadId: "mm-9" });
		expect(r.list()).toHaveLength(1);
		r.forgetServiceAccount("sa1");
		expect(r.list()).toEqual([]);
	});

	test("the dispatcher's observe hook feeds it", async () => {
		const c = clock();
		const r = new RunnerRegistry({ now: c.now });
		const work = fakeWork(c.now);
		work.add({ id: "mm-1" }, "build");
		const d = new Dispatcher({
			work,
			now: c.now,
			waitMs: 0,
			observe: r.observe,
		});
		await d.next("alice", "build", info("laptop", "sa1"));
		expect(r.list()[0]?.running).toEqual(["mm-1"]);
		await d.complete("alice", "mm-1", { actor: "alice/laptop", summary: "ok" });
		expect(r.list()[0]?.running).toEqual([]);
	});
});

describe("joinRunners", () => {
	const sa = (id: string, account = "alice") => ({
		id,
		account,
		name: `n-${id}`,
		createdAt: "2026-11-10T07:00:00.000Z",
	});

	test("shows enrolled service accounts that never connected, hides revoked runners", () => {
		const r = new RunnerRegistry({ now: () => new Date(T0) });
		r.observe({ kind: "next", queue: "q", runner: info("a", "sa1").runner });
		r.observe({ kind: "next", queue: "q", runner: info("b", "gone").runner });
		const rows = joinRunners(r.list(), [sa("sa1"), sa("sa2", "bob")]);
		expect(
			rows.map((x) => [x.account, x.runner, x.serviceAccount?.name, x.online]),
		).toEqual([
			["alice", "a", "n-sa1", true],
			["bob", null, "n-sa2", false],
		]);
	});

	test("auth off: the registry as is", () => {
		const r = new RunnerRegistry({ now: () => new Date(T0) });
		r.observe({ kind: "next", queue: "q", runner: info("a", "sa1").runner });
		expect(joinRunners(r.list(), null).map((x) => x.serviceAccount)).toEqual([
			null,
		]);
	});
});

async function setup(
	opts: { mode?: "on" | "off" | "unconfigured"; tickMs?: number } = {},
) {
	const auth = new Auth({
		accounts: new MemoryKv(),
		serviceAccounts: new MemoryKv(),
		tokens: new MemoryKv(),
		sessions: new MemoryKv(),
	});
	const mode = opts.mode ?? "on";
	const requireAccount: RequireAccount =
		mode === "on"
			? accountGuard(auth, "secret")
			: mode === "off"
				? async () => "local"
				: async () => Response.json({ error: "x" }, { status: 503 });
	const registry = new RunnerRegistry();
	const routes = peopleRoutes({
		requireAccount,
		auth: () => (mode === "on" ? auth : null),
		mode,
		registry,
		runnerScript: async () => new Response("// runner"),
		version: "sha1",
		tickMs: opts.tickMs,
	});
	return { auth, registry, routes };
}

async function loggedIn() {
	const s = await setup();
	const cookie = `mm_session=${await loginAs(s.auth, "admin")}`;
	const get = (path: string) =>
		new Request(`https://mm.example${path}`, { headers: { cookie } });
	return { ...s, get };
}

describe("routes", () => {
	test("setup is public: firstLogin until the first account exists", async () => {
		const { auth, routes } = await setup();
		const setupOf = async () =>
			(await (await routes["/api/people/setup"].GET()).json()) as PeopleSetup;
		expect(await setupOf()).toEqual({ auth: "on", firstLogin: true });
		await loginAs(auth, "admin");
		expect(await setupOf()).toEqual({ auth: "on", firstLogin: false });
	});

	test("every session route refuses a request without a session", async () => {
		const { routes } = await setup();
		const anon = new Request("https://mm.example/x");
		for (const path of [
			"/api/people/me",
			"/api/accounts",
			"/api/runners",
			"/api/people/events",
		] as const) {
			expect((await routes[path].GET(anon)).status).toBe(401);
		}
	});

	test("me, accounts with inviter, runners joined with service accounts", async () => {
		const { auth, registry, routes, get } = await loggedIn();
		await inviteAs(auth, "admin", "bob");
		const enrolled = await auth.enrol(await auth.enrolToken("admin", "laptop"));
		const saId = enrolled?.serviceAccount.id as string;
		const me = (await (
			await routes["/api/people/me"].GET(get("/api/people/me"))
		).json()) as Me;
		expect(me).toEqual({ account: "admin", auth: "on" });
		const accounts = (await (
			await routes["/api/accounts"].GET(get("/api/accounts"))
		).json()) as AccountsReply;
		expect(accounts.accounts.map((a) => [a.id, a.invitedBy])).toEqual([
			["admin", null],
			["bob", "admin"],
		]);
		const runners = async () =>
			(
				(await (
					await routes["/api/runners"].GET(get("/api/runners"))
				).json()) as RunnersReply
			).runners;
		expect((await runners()).map((r) => [r.runner, r.online])).toEqual([
			[null, false],
		]);
		const reply = (await (
			await routes["/api/runners"].GET(get("/api/runners"))
		).json()) as RunnersReply;
		expect(reply.serverVersion).toBe("sha1");
		registry.observe({
			kind: "next",
			queue: "build",
			runner: {
				id: "host1",
				account: "admin",
				serviceAccount: saId,
				providers: [],
				capabilities: [],
				capacity: 3,
			},
		});
		expect(
			(await runners()).map((r) => [r.runner, r.online, r.capacity, r.queues]),
		).toEqual([["host1", true, 3, ["build"]]]);
		await auth.revoke("admin", saId);
		expect(await runners()).toEqual([]);
	});

	test("auth off (AUTH_DISABLED): the local account, registry only", async () => {
		const { routes } = await setup({ mode: "off" });
		const req = new Request("https://mm.example/x");
		expect(await (await routes["/api/people/me"].GET(req)).json()).toEqual({
			account: "local",
			auth: "off",
		});
		const accounts = (await (
			await routes["/api/accounts"].GET(req)
		).json()) as AccountsReply;
		expect(accounts.accounts.map((a) => a.id)).toEqual(["local"]);
		expect(
			(await (await routes["/api/people/setup"].GET()).json()) as PeopleSetup,
		).toEqual({ auth: "off", firstLogin: false });
	});

	test("events: the runner list at once, then on every change", async () => {
		const { registry, routes, get } = await loggedIn();
		const abort = new AbortController();
		const req = new Request("https://mm.example/api/people/events", {
			headers: get("/").headers,
			signal: abort.signal,
		});
		const res = await routes["/api/people/events"].GET(req);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let text = "";
		const until = async (pred: (t: string) => boolean) => {
			while (!pred(text)) {
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				text += decoder.decode(value);
			}
		};
		await until((t) =>
			t.includes('data: {"runners":[],"serverVersion":"sha1"}'),
		);
		registry.observe({
			kind: "next",
			queue: "q",
			runner: {
				id: "r1",
				account: "admin",
				serviceAccount: "x",
				providers: [],
				capabilities: [],
			},
		});
		// Its service account does not exist: hidden, so the list is unchanged.
		registry.observe({
			kind: "next",
			queue: "q",
			runner: {
				id: "r2",
				account: "admin",
				serviceAccount: "",
				providers: [],
				capabilities: [],
			},
		});
		await until((t) => t.includes('"runner":"r2"'));
		expect(text.match(/event: runners/g)?.length).toBe(2);
		abort.abort();
		await reader.cancel();
	});
});

describe("runner.js", () => {
	test("serves the built file when it exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mm-runner-"));
		try {
			const built = join(dir, "runner.js");
			await Bun.write(built, "console.log('runner')");
			const res = await runnerScript({ built, source: "/nope" })();
			expect(res.headers.get("content-type")).toContain("javascript");
			expect(await res.text()).toBe("console.log('runner')");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("404 when neither the bundle nor the source exists", async () => {
		const res = await runnerScript({ built: "/nope.js", source: "/nope.ts" })();
		expect(res.status).toBe(404);
	});

	test("bundles from source in dev", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mm-runner-"));
		try {
			const source = join(dir, "cli.ts");
			await Bun.write(source, "const n: number = 41; console.log(n + 1);");
			const res = await runnerScript({ built: join(dir, "x.js"), source })();
			expect(await res.text()).toContain("console.log");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});
