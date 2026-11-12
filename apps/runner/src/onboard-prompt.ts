/**
 * The terminal side of `onboard` (mm-210.67): a numbered menu, a visible
 * line that can be cancelled (the GitHub callback may arrive first), a hidden
 * value, and opening the browser. Not interactive (`--non-interactive`, or
 * stdin is not a terminal): only flags and stdin.
 */
import { createInterface } from "node:readline/promises";
import type { Choice, Prompt } from "./onboard-credentials.ts";

export type PromptIo = {
	/** Lines for the user (stderr when --json owns stdout). */
	out: (line: string) => void;
	interactive: boolean;
	/** One visible line (tests); default: readline on the terminal. */
	ask?: (prompt: string, signal?: AbortSignal) => Promise<string>;
	readSecret: (prompt: string) => Promise<string>;
	/** Do not start a browser (print the URL only). */
	noBrowser?: boolean;
};

async function terminalLine(
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await rl.question(prompt, signal ? { signal } : {});
	} finally {
		rl.close();
	}
}

/** The browser command of this OS, or null. */
export function openCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): string[] | null {
	if (platform === "darwin") return ["open", url];
	if (platform === "win32") return ["cmd", "/c", "start", "", url];
	// No display: a server over ssh; print the URL only.
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
	return Bun.which("xdg-open") ? ["xdg-open", url] : null;
}

export function terminalPrompt(io: PromptIo): Prompt {
	const line = io.ask ?? terminalLine;
	return {
		interactive: io.interactive,
		out: io.out,
		line,
		secret: io.readSecret,
		choose: async (question: string, choices: Choice[]) => {
			io.out(question);
			choices.forEach((c, i) => {
				io.out(`  ${i + 1}. ${c.label}: ${c.why}`);
			});
			for (;;) {
				const a = (await line(`choose 1-${choices.length}: `)).trim();
				const n = Number(a);
				const c =
					choices[n - 1] ?? choices.find((x) => x.key === a.toLowerCase());
				if (c) return c.key;
				io.out(`  type a number from 1 to ${choices.length}`);
			}
		},
		open: (url: string) => {
			if (io.noBrowser) return;
			const cmd = openCommand(url);
			if (!cmd) return;
			try {
				Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
			} catch {}
		},
	};
}
