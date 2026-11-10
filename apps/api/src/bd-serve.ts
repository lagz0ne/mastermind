// `bd serve`: the write path for beads (claims, leases, events journal).
// The api runs it as a child on loopback (no token needed there) against the
// external Dolt sql-server, and restarts it whenever it exits.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Probe } from "@mastermind/core";
import type { DoltTarget } from "./dolt.ts";

/** Env that points bd at the Dolt server; the password never goes on argv. */
export function bdEnv(dolt: DoltTarget, beadsDir: string) {
	return {
		BEADS_DIR: beadsDir,
		BEADS_DOLT_SERVER_HOST: dolt.host,
		BEADS_DOLT_SERVER_PORT: String(dolt.port),
		BEADS_DOLT_SERVER_USER: dolt.user,
		BEADS_DOLT_PASSWORD: dolt.password,
		BEADS_ACTOR: "mastermind",
	};
}

/**
 * Write a server-mode beads workspace at `root` and return its beads dir. All
 * state lives in Dolt, so the directory is disposable and rewritten on every
 * boot. bd resolves the workspace from a git repository root, so `root` is
 * made a (never committed) git repo. The events journal is a workspace
 * setting (config.yaml), not a database one.
 */
export async function writeWorkspace(
	root: string,
	database: string,
): Promise<string> {
	const beadsDir = join(root, ".beads");
	await mkdir(beadsDir, { recursive: true, mode: 0o700 });
	await chmod(beadsDir, 0o700);
	if (!(await Bun.file(join(root, ".git", "HEAD")).exists())) {
		const git = Bun.spawn(["git", "init", "-q", root], { stderr: "inherit" });
		if ((await git.exited) !== 0) throw new Error(`git init ${root} failed`);
	}
	const metadata = {
		database: "dolt",
		backend: "dolt",
		dolt_mode: "server",
		dolt_database: database,
	};
	await writeFile(
		join(beadsDir, "metadata.json"),
		`${JSON.stringify(metadata, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(join(beadsDir, "config.yaml"), "events-journal: true\n", {
		mode: 0o600,
	});
	return beadsDir;
}

/** The `bd init` that creates the beads schema in a database that doesn't exist yet. */
export function initArgs(bin: string, dolt: DoltTarget, prefix: string) {
	return [
		bin,
		"init",
		"--server",
		"--external",
		"--server-host",
		dolt.host,
		"--server-port",
		String(dolt.port),
		"--server-user",
		dolt.user,
		"--database",
		dolt.database,
		"--prefix",
		prefix,
		"--non-interactive",
		"--skip-hooks",
		"--skip-agents",
		"--quiet",
	];
}

/**
 * First boot only: create the database and schema. bd init also scaffolds a
 * project directory, so it runs in a scratch dir that is thrown away.
 */
export async function bootstrap(
	bin: string,
	dolt: DoltTarget,
	prefix: string,
): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), "mastermind-bd-init-"));
	try {
		// bd init wants a git repository to scaffold into.
		const git = Bun.spawn(["git", "init", "-q", scratch], {
			stderr: "inherit",
		});
		if ((await git.exited) !== 0) throw new Error(`git init ${scratch} failed`);
		const proc = Bun.spawn(initArgs(bin, dolt, prefix), {
			cwd: scratch,
			// No BEADS_DIR: init must scaffold the scratch dir, not a live workspace.
			env: {
				...process.env,
				BEADS_DIR: "",
				BEADS_DOLT_PASSWORD: dolt.password,
			},
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) throw new Error(`bd init exited with ${code}`);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export type Supervisor = { url: string; stop: () => Promise<void> };

export type SuperviseOptions = {
	/** Full argv; the supervisor runs it as is. */
	cmd: string[];
	port: number;
	/** Working directory of the child (bd serve: the workspace root). */
	cwd?: string;
	env?: Record<string, string>;
	/** First restart delay; doubles per quick crash up to maxDelayMs. */
	delayMs?: number;
	maxDelayMs?: number;
	log?: (line: string) => void;
};

/** `bd serve` argv on loopback; the port is fixed so a second serve fails to bind. */
export function serveCmd(bin: string, port: number): string[] {
	return [bin, "serve", "--addr", `127.0.0.1:${port}`];
}

/** Keep a child running: restart it when it exits, with backoff on crash loops. */
export function supervise(opts: SuperviseOptions): Supervisor {
	const { cmd, port, delayMs = 500, maxDelayMs = 30_000 } = opts;
	const log = opts.log ?? ((line) => console.log(line));
	let child: ReturnType<typeof Bun.spawn> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopping = false;
	let delay = delayMs;

	const start = () => {
		timer = null;
		if (stopping) return;
		const startedAt = Date.now();
		child = Bun.spawn(cmd, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdout: "inherit",
			stderr: "inherit",
			onExit: (_proc, code, signal) => {
				child = null;
				if (stopping) return;
				// A run that lasted a while resets the backoff.
				if (Date.now() - startedAt > 60_000) delay = delayMs;
				log(
					`bd serve exited (code ${code}, signal ${signal}); restarting in ${delay}ms`,
				);
				timer = setTimeout(start, delay);
				delay = Math.min(delay * 2, maxDelayMs);
			},
		});
	};
	start();

	return {
		url: `http://127.0.0.1:${port}`,
		async stop() {
			stopping = true;
			if (timer) clearTimeout(timer);
			const running = child;
			if (running) {
				running.kill("SIGTERM");
				await running.exited;
			}
		},
	};
}

/** Readiness, not liveness: /v0/beads/ready runs a real query against Dolt. */
export async function checkBd(url: string | null): Promise<Probe> {
	if (!url) return "unconfigured";
	try {
		const res = await fetch(`${url}/v0/beads/ready?limit=1`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok ? "up" : "down";
	} catch {
		return "down";
	}
}
