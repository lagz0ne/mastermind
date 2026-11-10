// Production build: bundles the API and the UI it imports (apps/web/index.html)
// into dist/. A script rather than the bun build CLI so the Tailwind plugin runs.
import tailwind from "bun-plugin-tailwind";

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
});

for (const log of [...result.logs, ...runner.logs]) console.error(log);
if (!result.success || !runner.success) process.exit(1);
for (const out of [...result.outputs, ...runner.outputs]) {
	console.log(
		`${out.path.slice(process.cwd().length + 1)}  ${(out.size / 1024).toFixed(1)} KiB`,
	);
}
