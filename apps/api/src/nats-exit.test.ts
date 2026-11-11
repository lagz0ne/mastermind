import { expect, test } from "bun:test";
import { exitOnNatsClosed, NATS_CLOSED_EXIT } from "./nats-exit.ts";

test("a closed NATS connection logs one line and exits non-zero, once", () => {
	const exits: number[] = [];
	const lines: string[] = [];
	const closed = exitOnNatsClosed({
		exit: (code) => exits.push(code),
		log: (line) => lines.push(line),
	});
	closed("mastermind", new Error("Authorization Violation"));
	closed("mastermind-sys");
	closed("mastermind-auth");
	expect(NATS_CLOSED_EXIT).not.toBe(0);
	expect(exits).toEqual([NATS_CLOSED_EXIT]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain(
		"mastermind closed (Error: Authorization Violation)",
	);
});

test("the real process exits non-zero", async () => {
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			`import { exitOnNatsClosed } from ${JSON.stringify(`${import.meta.dir}/nats-exit.ts`)};
			exitOnNatsClosed({ log: () => {} })("mastermind");
			setTimeout(() => {}, 10_000);`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	expect(await proc.exited).toBe(NATS_CLOSED_EXIT);
});
