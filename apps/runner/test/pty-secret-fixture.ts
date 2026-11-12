// Fixture for secret-prompt.test.ts: a menu line, a hidden secret, twice, in
// one process, on a terminal. Prints one RESULT line (lengths, never values).
import { createInterface } from "node:readline/promises";
import { readSecretFromStdin } from "../src/secrets/command.ts";

async function line(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
	}
}

try {
	const a = await line("menu-1> ");
	const s1 = await readSecretFromStdin("secret-1> ");
	const b = await line("menu-2> ");
	const s2 = await readSecretFromStdin("secret-2> ");
	console.log(`RESULT ${a} ${s1.length} ${b} ${s2.length}`);
} catch (error) {
	console.log(`RESULT ERROR ${error instanceof Error ? error.message : error}`);
}
process.exit(0);
