// A runner stand-in for the crash test: starts one box task whose agent
// sleeps, prints READY when the box is filled, and waits to be killed.
import { DockerDriver } from "../../src/box/docker.ts";
import { runInBox } from "../../src/box/run.ts";

const [runnerId = "", image = ""] = process.argv.slice(2);
const driver = new DockerDriver({
	env: { DOCKER_HOST: process.env.MM_BOX_DOCKER_HOST },
});
await runInBox(
	{
		executionId: `crash-${Date.now()}`,
		beadId: "mm-crash",
		runnerId,
		title: "crash",
		prompt: "sleep",
		env: { repo: "", ref: "", requires: [], image },
		agent: {},
		secrets: {},
	},
	{
		driver,
		defaultImage: image,
		readyCommand: null,
		agentCommand: () => ["sleep", "600"],
		onStep: (l) => {
			if (l.includes("ready in")) console.log("READY");
		},
	},
	new AbortController().signal,
);
