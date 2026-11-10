// Production build: bundles the API and the UI it imports (apps/web/index.html)
// into dist/. A script rather than the bun build CLI so the Tailwind plugin runs.
import tailwind from "bun-plugin-tailwind";
import {
	buildRunners,
	parseTargets,
	RUNNER_DIR,
} from "./src/download/runner-build.ts";

// The commit; the runner reports it as its version, /people compares it with the server's.
const version = process.env.GIT_SHA || "dev";

const result = await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "bun",
	publicPath: "/",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	plugins: [tailwind],
});

// The runner adapter as one file, served at GET /runner.js (src/people/runner-script.ts).
const runner = await Bun.build({
	entrypoints: ["../runner/src/cli.ts"],
	outdir: "dist",
	target: "bun",
	naming: "runner.js",
	minify: true,
	define: {
		"process.env.MASTERMIND_RUNNER_VERSION": JSON.stringify(version),
	},
});

// The JetStream backup CLI, in the image as /app/backup.js (src/backup/cli.ts, docs/deploy.md).
const backup = await Bun.build({
	entrypoints: ["src/backup/cli.ts"],
	outdir: "dist",
	target: "bun",
	naming: "backup.js",
	minify: true,
});

const builds = [result, runner, backup];
for (const log of builds.flatMap((b) => b.logs)) console.error(log);
if (!builds.every((b) => b.success)) process.exit(1);
for (const out of builds.flatMap((b) => b.outputs)) {
	console.log(
		`${out.path.slice(process.cwd().length + 1)}  ${(out.size / 1024).toFixed(1)} KiB`,
	);
}

// Compiled runners, served at /download/mastermind-runner (src/download/routes.ts).
// Only when RUNNER_TARGETS is set (the image build: "all"): each target is ~100 MiB
// (~45 MiB gzipped) and cross targets download a Bun runtime.
const targets = parseTargets(process.env.RUNNER_TARGETS ?? "");
if (targets.length) {
	await buildRunners({
		source: "../runner/src/cli.ts",
		dir: `dist/${RUNNER_DIR}`,
		targets,
		version,
		log: (line) => console.log(`dist/${RUNNER_DIR}/${line}`),
	});
}
