/**
 * `mastermind-runner secrets ...` (mm-210.51):
 *
 *   secrets [list] [--json]   NAME | NEEDED BY | PRESENT (never a value)
 *   secrets set <NAME>        value from stdin, or typed at a hidden prompt
 *   secrets unset <NAME>
 *   secrets check             exit 1 when a needed secret is missing
 *
 * A value is never taken from the command line (it would stay in the shell
 * history and in `ps`).
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { SecretsState } from "./state.ts";
import { isSecretName, SecretStore } from "./store.ts";

export type SecretsIo = {
	out: (line: string) => void;
	err: (line: string) => void;
	/** Read one value: stdin when piped, else a prompt without echo. */
	readSecret?: (prompt: string) => Promise<string>;
};

export const SECRETS_USAGE = `secrets:
  mastermind-runner secrets [list] [--json]
  mastermind-runner secrets set <NAME>     (value from stdin or a hidden prompt)
  mastermind-runner secrets unset <NAME>
  mastermind-runner secrets check          (exit 1 when a needed one is missing)`;

/** Rows as a text table, never with values. */
export function formatSecrets(s: SecretsState): string[] {
	const head = ["NAME", "NEEDED BY", "PRESENT"];
	const body = s.rows.map((r) => [
		r.name,
		r.neededBy.join(",") || "- (not needed)",
		r.present ? `yes (${r.from})` : "NO",
	]);
	const w = head.map((h, i) =>
		Math.max(h.length, ...body.map((b) => (b[i] as string).length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(w[i] as number))
			.join("  ")
			.trimEnd();
	const out = body.length ? [line(head), ...body.map(line)] : ["no secrets"];
	if (s.problem) out.push(`note: ${s.problem}`);
	for (const name of s.diagnostics.missing)
		out.push(`fix: mastermind-runner secrets set ${name}`);
	return out;
}

/**
 * Read stdin to the end (piped), or one line typed with echo off (a tty).
 *
 * On a tty this uses node:readline, the SAME reader as the onboard menus
 * (onboard-prompt.ts). A second kind of reader on stdin in one process (Bun's
 * `for await (const line of console)`) fails with "ReadableStream is locked"
 * after readline has read a line. The output is a sink, so readline's echo of
 * the typed characters goes nowhere.
 */
export async function readSecretFromStdin(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const text = await Bun.stdin.text();
		return text.replace(/\r?\n$/, "");
	}
	const sink = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	});
	// Raw mode first, then the prompt: a value pasted the moment the prompt
	// shows must not be echoed by the terminal itself.
	const rl = createInterface({
		input: process.stdin,
		output: sink,
		terminal: true,
	});
	process.stderr.write(prompt);
	try {
		return await rl.question("");
	} finally {
		rl.close();
		process.stderr.write("\n");
	}
}

export async function secretsCommand(
	args: string[],
	ctx: {
		file: string;
		json: boolean;
		state: () => Promise<SecretsState>;
		io: SecretsIo;
	},
): Promise<number> {
	const { io } = ctx;
	const [sub = "list", name, ...extra] = args;
	const usage = (msg: string) => {
		io.err(`${msg}\n${SECRETS_USAGE}`);
		return 2;
	};
	const store = new SecretStore(ctx.file);
	switch (sub) {
		case "list":
		case "check": {
			if (name) return usage(`secrets ${sub} takes no name`);
			const s = await ctx.state();
			if (ctx.json)
				io.out(
					JSON.stringify(
						{
							file: ctx.file,
							rows: s.rows,
							...s.diagnostics,
						},
						null,
						2,
					),
				);
			else for (const l of formatSecrets(s)) io.out(l);
			if (sub === "list") return 0;
			if (!s.needs) return 1;
			return s.diagnostics.missing.length ? 1 : 0;
		}
		case "set": {
			if (!name) return usage("secrets set needs a NAME");
			if (extra.length)
				return usage(
					'the value is never taken from the command line: pipe it in (printf %s "$V" | mastermind-runner secrets set NAME) or type it at the prompt',
				);
			if (!isSecretName(name))
				return usage(`bad secret name ${name}: letters, digits and '_' only`);
			const value = await (io.readSecret ?? readSecretFromStdin)(
				`value for ${name} (hidden): `,
			);
			if (!value) {
				io.err(`no value for ${name}; nothing stored`);
				return 1;
			}
			await store.set(name, value);
			io.out(`${name} stored in ${ctx.file}`);
			return 0;
		}
		case "unset":
		case "rm": {
			if (!name || extra.length) return usage("secrets unset needs one NAME");
			const had = await store.unset(name);
			io.out(had ? `${name} removed` : `${name} was not stored`);
			return 0;
		}
		default:
			return usage(`unknown secrets command ${sub}`);
	}
}
