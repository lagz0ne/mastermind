import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BdError } from "@mastermind/beads";
import { bdHeartbeat } from "./heartbeat.ts";

// A stand-in for bd: records argv, cwd and env, then acts per $STUB_MODE.
const dir = mkdtempSync(join(tmpdir(), "mm-heartbeat-"));
const bin = join(dir, "bd");
const record = join(dir, "record");
writeFileSync(
	bin,
	`#!/bin/sh
printf '%s\\n' "$*" "$PWD" "$BEADS_ACTOR" "$BEADS_DIR" > "${record}"
case "$STUB_MODE" in
  refuse) echo '{"error": "heartbeat mm-1: issue already claimed by bob/x", "schema_version": 1}'; exit 1 ;;
  crash) echo 'boom' >&2; exit 2 ;;
  *) echo '{"id": "mm-1", "status": "heartbeat"}' ;;
esac
`,
);
chmodSync(bin, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const heartbeat = (mode: string) =>
	bdHeartbeat({
		bin,
		cwd: dir,
		env: { BEADS_DIR: join(dir, ".beads"), STUB_MODE: mode },
	});

describe("bdHeartbeat", () => {
	test("runs bd heartbeat as the holder in the workspace", async () => {
		await heartbeat("ok")("mm-1", "alice/laptop");
		const [args, cwd, actor, beadsDir] = (await Bun.file(record).text()).split(
			"\n",
		);
		expect(args).toBe("heartbeat --json -- mm-1");
		expect(cwd).toBe(dir);
		expect(actor).toBe("alice/laptop");
		expect(beadsDir).toBe(join(dir, ".beads"));
	});

	test("a refusal is a 409 BdError with bd's message", async () => {
		const error = await heartbeat("refuse")("mm-1", "alice/laptop").catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(BdError);
		expect(error.status).toBe(409);
		expect(error.message).toContain("already claimed by bob/x");
	});

	test("a crash is a plain error with stderr", async () => {
		const error = await heartbeat("crash")("mm-1", "alice/laptop").catch(
			(e) => e,
		);
		expect(error).not.toBeInstanceOf(BdError);
		expect(error.message).toContain("exited with 2: boom");
	});
});
