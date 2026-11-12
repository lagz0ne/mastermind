import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * mm-210.78: onboard asked a menu (node:readline) and then a hidden secret
 * with a second kind of stdin reader; on a terminal that failed with
 * "Invalid state: ReadableStream is locked". This runs the real prompt code on
 * a pseudo-terminal and answers each prompt when it appears.
 */
test("menu, hidden secret, menu, hidden secret on one terminal", async () => {
	const answers: [string, string][] = [
		["menu-1> ", "1"],
		["secret-1> ", "sk-ant-oat-SECRETVALUE"],
		["menu-2> ", "2"],
		["secret-2> ", "second-SECRET"],
	];
	let screen = "";
	let next = 0;
	const decoder = new TextDecoder();
	const proc = Bun.spawn(
		[process.execPath, join(import.meta.dir, "pty-secret-fixture.ts")],
		{
			terminal: {
				cols: 100,
				rows: 30,
				data(terminal, data) {
					screen += decoder.decode(data, { stream: true });
					const step = answers[next];
					if (step && screen.includes(step[0])) {
						next++;
						terminal.write(`${step[1]}\r`);
					}
				},
			},
		},
	);
	const timer = setTimeout(() => proc.kill(), 20_000);
	await proc.exited;
	clearTimeout(timer);

	expect(screen).toContain("RESULT 1 22 2 13");
	// The secrets are typed, never shown.
	expect(screen).not.toContain("SECRETVALUE");
	expect(screen).not.toContain("second-SECRET");
}, 30_000);
