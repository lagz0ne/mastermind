// A stand-in for the paseo CLI in tests: `bun test/fake-paseo.ts <args>`.
// State lives in $FAKE_PASEO_DIR (agents.json, calls.jsonl).
// The prompt steers `run`: FAKE:fail, FAKE:slow, FAKE:crash, FAKE:garbage.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

type Agent = { id: string; labels: Record<string, string>; cwd: string };

const dir = process.env.FAKE_PASEO_DIR;
if (!dir) {
	console.error("FAKE_PASEO_DIR is not set");
	process.exit(9);
}
const agentsFile = join(dir, "agents.json");
const agents = (): Agent[] =>
	existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, "utf8")) : [];
const args = process.argv.slice(2);
appendFileSync(
	join(dir, "calls.jsonl"),
	`${JSON.stringify({ args, agentEnv: process.env.PASEO_AGENT_ID ?? null })}\n`,
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
