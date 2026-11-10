/**
 * `GET /runner.js`: the runner adapter (apps/runner) as one file for Bun, so a
 * machine gets it with curl. The production build writes it next to index.js
 * (apps/api/build.ts); in dev it is bundled from source on first request.
 */
import { join } from "node:path";

/** Where build.ts puts the bundle, relative to the built index.js. */
export const RUNNER_FILE = "runner.js";
const SOURCE = join(import.meta.dir, "../../../runner/src/cli.ts");

export type RunnerScript = () => Promise<Response>;

export function runnerScript(
	opts: { built?: string; source?: string } = {},
): RunnerScript {
	const built = opts.built ?? join(import.meta.dir, RUNNER_FILE);
	const source = opts.source ?? SOURCE;
	let bundle: Promise<Blob | null> | null = null;

	const load = async (): Promise<Blob | null> => {
		const file = Bun.file(built);
		if (await file.exists()) return file;
		if (!(await Bun.file(source).exists())) return null;
		const out = await Bun.build({ entrypoints: [source], target: "bun" });
		const js = out.success ? out.outputs[0] : undefined;
		if (!js) throw new Error(`runner bundle failed: ${out.logs.join("\n")}`);
		return new Blob([await js.arrayBuffer()]);
	};

	return async () => {
		bundle ??= load().catch((error) => {
			bundle = null;
			throw error;
		});
		const blob = await bundle;
		if (!blob)
			return Response.json({ error: "runner bundle missing" }, { status: 404 });
		return new Response(blob, {
			headers: {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	};
}
