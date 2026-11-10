import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import {
	bdEnv,
	bootstrap,
	checkBd,
	initArgs,
	serveCmd,
	supervise,
	writeWorkspace,
} from "./bd-serve.ts";
import { hasBeadsSchema, parseDoltUrl, serverUrl } from "./dolt.ts";

const dolt = parseDoltUrl("mysql://root:s3cret@dolt:3306/mastermind");
const scratch = await mkdtemp(join(tmpdir(), "bd-serve-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

test("writeWorkspace writes a private server-mode workspace with the journal on", async () => {
	const root = join(scratch, "ws");
	const dir = await writeWorkspace(root, "mastermind");
	expect(await writeWorkspace(root, "mastermind")).toBe(dir); // every boot
	expect(dir).toBe(join(root, ".beads"));
	expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(true);
	expect((await stat(dir)).mode & 0o777).toBe(0o700);
	expect(
		JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")),
	).toEqual({
		database: "dolt",
		backend: "dolt",
		dolt_mode: "server",
		dolt_database: "mastermind",
	});
	expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(
		"events-journal: true\n",
	);
});

test("the Dolt password reaches bd through env, never argv", () => {
	expect(bdEnv(dolt, "/w/.beads")).toMatchObject({
		BEADS_DIR: "/w/.beads",
		BEADS_DOLT_SERVER_HOST: "dolt",
		BEADS_DOLT_SERVER_PORT: "3306",
		BEADS_DOLT_SERVER_USER: "root",
		BEADS_DOLT_PASSWORD: "s3cret",
	});
	const argv = [...initArgs("bd", dolt, "mm"), ...serveCmd("bd", 3010)];
	expect(argv.join(" ")).not.toContain("s3cret");
	expect(serveCmd("bd", 3010)).toEqual([
		"bd",
		"serve",
		"--addr",
		"127.0.0.1:3010",
	]);
});

test("supervise restarts the child when it exits, and stop ends it", async () => {
	const runs = join(scratch, "runs");
	// A child that records each start and exits at once: a crash loop.
	const cmd = [
		process.execPath,
		"-e",
		`require("node:fs").appendFileSync(${JSON.stringify(runs)}, "x")`,
	];
	const lines: string[] = [];
	const sup = supervise({
		cmd,
		port: 1,
		delayMs: 20,
		maxDelayMs: 40,
		log: (l) => lines.push(l),
	});
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const n = await readFile(runs, "utf8").catch(() => "");
		if (n.length >= 3) break;
		await Bun.sleep(20);
	}
	await sup.stop();
	const started = (await readFile(runs, "utf8")).length;
	expect(started).toBeGreaterThanOrEqual(3);
	expect(lines[0]).toContain("restarting in 20ms");
	await Bun.sleep(150);
	expect((await readFile(runs, "utf8")).length).toBe(started);
});

test("stop terminates a long-running child", async () => {
	const sup = supervise({
		cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		port: 1,
		log: () => {},
	});
	await Bun.sleep(100);
	await sup.stop(); // resolves only once the child has exited
});

test("checkBd is ready only when the ready query answers 200", async () => {
	let status = 200;
	const fake = Bun.serve({
		port: 0,
		fetch: (req) =>
			new URL(req.url).pathname === "/v0/beads/ready"
				? new Response("[]", { status })
				: new Response("", { status: 404 }),
	});
	try {
		expect(await checkBd(null)).toBe("unconfigured");
		expect(await checkBd(fake.url.origin)).toBe("up");
		status = 503; // live but Dolt unreachable
		expect(await checkBd(fake.url.origin)).toBe("down");
	} finally {
		fake.stop(true);
	}
	expect(await checkBd("http://127.0.0.1:1")).toBe("down");
});

// End to end against a real Dolt sql-server and bd binary. Opt in with
// MASTERMIND_TEST_DOLT_URL=mysql://user:pw@127.0.0.1:port/<scratch db name>,
// and BD_BIN pointing at the native bd binary (not the npm wrapper, which
// does not pass SIGTERM on to it).
const e2eUrl = process.env.MASTERMIND_TEST_DOLT_URL;
test.skipIf(!e2eUrl)(
	"a bead created through bd serve appears in a Bun.SQL read",
	async () => {
		const url = e2eUrl as string;
		const target = parseDoltUrl(url);
		const bin = process.env.BD_BIN ?? "bd";
		const server = new SQL(serverUrl(url));
		if (!(await hasBeadsSchema(server, target.database))) {
			await bootstrap(bin, target, "e2e");
		}
		await server.close();
		const root = join(scratch, "e2e");
		const beadsDir = await writeWorkspace(root, target.database);
		const port = 20_000 + Math.floor(Math.random() * 20_000);
		const sup = supervise({
			cmd: serveCmd(bin, port),
			port,
			cwd: root,
			env: bdEnv(target, beadsDir),
		});
		const sql = new SQL(url);
		try {
			const deadline = Date.now() + 15_000;
			while ((await checkBd(sup.url)) !== "up") {
				if (Date.now() > deadline) throw new Error("bd serve never got ready");
				await Bun.sleep(100);
			}
			const res = await fetch(`${sup.url}/v0/beads/issues`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "e2e probe",
					issue_type: "task",
					actor: "e2e",
				}),
			});
			expect(res.status).toBeLessThan(300);
			const body = (await res.json()) as {
				id?: string;
				issue?: { id: string };
			};
			const id = body.issue?.id ?? body.id;
			const rows = await sql`select id, title from issues where id = ${id}`;
			expect(rows).toEqual([{ id, title: "e2e probe" }]);
			const journal =
				await sql`select op from bd_events_journal where issue_id = ${id}`;
			expect(journal).toEqual([{ op: "create" }]);
		} finally {
			await sup.stop();
			await sql.close();
		}
	},
	30_000,
);
