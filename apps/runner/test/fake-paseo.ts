// A stand-in for the paseo CLI in tests: `bun test/fake-paseo.ts <args>`.
// State lives in $FAKE_PASEO_DIR (agents.json, calls.jsonl).
// The prompt steers `run`: FAKE:fail, FAKE:slow, FAKE:crash, FAKE:garbage, FAKE:nologin.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type Agent = { id: string; labels: Record<string, string>; cwd: string };

const NO_LOGIN_ERROR = {
	code: "OUTPUT_SCHEMA_FAILED",
	message: "Agent response did not match the required output schema",
	details:
		"Invalid JSON: Unexpected token 'N', \"Not logged\"... is not valid JSON",
};

const dir = process.env.FAKE_PASEO_DIR;
if (!dir) {
	console.error("FAKE_PASEO_DIR is not set");
	process.exit(9);
}
const agentsFile = join(dir, "agents.json");
const agents = (): Agent[] =>
	existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, "utf8")) : [];
const args = process.argv.slice(2);
// What an agent would find at MASTERMIND_ENV_FILE while `run` is in progress.
const envFileArg = args
	.find((a) => a.startsWith("MASTERMIND_ENV_FILE="))
	?.slice("MASTERMIND_ENV_FILE=".length);
const envFile =
	envFileArg && existsSync(envFileArg)
		? {
				path: envFileArg,
				text: readFileSync(envFileArg, "utf8"),
				mode: statSync(envFileArg).mode & 0o777,
				dirMode: statSync(dirname(envFileArg)).mode & 0o777,
			}
		: null;
appendFileSync(
	join(dir, "calls.jsonl"),
	`${JSON.stringify({ args, agentEnv: process.env.PASEO_AGENT_ID ?? null, envFile })}\n`,
);

const flags = (name: string) =>
	args.flatMap((a, i) =>
		a === name && args[i + 1] ? [args[i + 1] as string] : [],
	);
const labelsOf = () =>
	Object.fromEntries(
		flags("--label").map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
	);

switch (args[0]) {
	case "ls": {
		const want = labelsOf();
		const list = agents().filter((a) =>
			Object.entries(want).every(([k, v]) => a.labels[k] === v),
		);
		console.log(
			JSON.stringify(list.map((a) => ({ id: a.id, status: "idle" }))),
		);
		break;
	}
	case "run": {
		const prompt = args.at(-1) ?? "";
		// Like the real CLI: no --provider, no agent.
		if (!flags("--provider").length) {
			console.log(
				JSON.stringify({
					error: {
						code: "MISSING_PROVIDER",
						message: "Provider is required",
						details:
							"Pass --provider <provider> or --provider <provider>/<model>",
					},
				}),
			);
			process.exit(1);
		}
		// Like claude in a mode that asks: nobody answers, no structured output.
		const mode = flags("--mode")[0];
		if (
			flags("--provider")[0]?.startsWith("claude") &&
			["default", "plan", "acceptEdits", undefined].includes(mode)
		) {
			console.log(
				JSON.stringify({
					error: {
						code: "OUTPUT_SCHEMA_FAILED",
						message:
							"Agent is waiting for permission before producing structured output",
					},
				}),
			);
			process.exit(1);
		}
		const agent: Agent = {
			id: `agent-${agents().length + 1}`,
			labels: labelsOf(),
			cwd: flags("--cwd")[0] ?? "",
		};
		writeFileSync(agentsFile, JSON.stringify([...agents(), agent]));
		console.error("Created workspace wks_fake");
		if (prompt.includes("FAKE:crash")) {
			console.error("daemon is not running");
			process.exit(2);
		}
		// paseo 0.15.4 with claude and no credential (probe mm-210.72): the
		// agent is made, answers 'Not logged in · Please run /login' 3 times.
		if (prompt.includes("FAKE:nologin")) {
			console.log(JSON.stringify({ error: NO_LOGIN_ERROR }, null, 2));
			process.exit(1);
		}
		if (prompt.includes("FAKE:slow")) await Bun.sleep(60_000);
		if (prompt.includes("FAKE:garbage")) {
			console.log("hello there");
			break;
		}
		const failed = prompt.includes("FAKE:fail");
		console.log(
			JSON.stringify(
				{
					status: failed ? "failed" : "done",
					summary: failed ? "could not do it" : `did: ${prompt.split("\n")[0]}`,
				},
				null,
				2,
			),
		);
		break;
	}
	case "stop":
		break;
	default:
		console.error(`fake paseo: unknown command ${args[0]}`);
		process.exit(1);
}
