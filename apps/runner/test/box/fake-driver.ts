// In-memory box driver for box lifecycle tests.
import type {
	Box,
	BoxDriver,
	BoxInfo,
	BoxSpec,
	ExecOptions,
	ExecResult,
	ImageRecipe,
} from "../../src/box/driver.ts";
import { tar } from "../../src/box/tar.ts";

export type ExecCall = { box: string; cmd: string[]; opts: ExecOptions };
export type Handler = (
	cmd: string[],
	opts: ExecOptions,
) => ExecResult | undefined | Promise<ExecResult | undefined>;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/** Answers for the fixed steps; a test overrides with `handler`. */
function defaults(cmd: string[]): ExecResult {
	if (cmd[0] === "id") return ok("1000\n");
	if (cmd[0] === "git" && cmd[1] === "rev-parse") return ok("abc123def4567\n");
	if (cmd[0] === "paseo" && cmd[1] === "run")
		return ok(JSON.stringify({ status: "done", summary: "did it" }));
	return ok();
}

export class FakeDriver implements BoxDriver {
	readonly name = "fake";
	readonly images: ImageRecipe[] = [];
	readonly created: BoxSpec[] = [];
	readonly execs: ExecCall[] = [];
	readonly copiedIn: { box: string; dir: string; names: string[] }[] = [];
	/** Boxes that exist, by id. */
	readonly boxes = new Map<string, BoxInfo>();
	readonly removed: string[] = [];
	handler: Handler = () => undefined;
	patch = "diff --git a/x b/x\n";
	createError: Error | null = null;
	#n = 0;

	async ping() {
		return "fake 1.0";
	}
	async ensureImage(recipe: ImageRecipe) {
		this.images.push(recipe);
		return recipe.tools?.length ? `built:${recipe.hash}` : recipe.image;
	}
	async create(spec: BoxSpec): Promise<Box> {
		if (this.createError) throw this.createError;
		this.created.push(spec);
		const id = `box${++this.#n}`;
		this.boxes.set(id, { id, name: spec.name, labels: spec.labels });
		const drv = this;
		return {
			id,
			name: spec.name,
			async exec(cmd, opts = {}) {
				if (!drv.boxes.has(id)) throw new Error("no such container");
				drv.execs.push({ box: id, cmd, opts });
				const r = (await drv.handler(cmd, opts)) ?? defaults(cmd);
				if (!drv.boxes.has(id)) throw new Error("container removed");
				return r;
			},
			async copyIn(dir, files) {
				drv.copiedIn.push({ box: id, dir, names: files.map((f) => f.name) });
			},
			async copyOut(path) {
				return tar([{ name: path.split("/").pop() ?? "f", data: drv.patch }]);
			},
			async logs() {
				return "daemon log";
			},
			async destroy() {
				await drv.remove(id);
			},
		};
	}
	async list(labels: Record<string, string>) {
		return [...this.boxes.values()].filter((b) =>
			Object.entries(labels).every(([k, v]) => b.labels[k] === v),
		);
	}
	async remove(id: string) {
		if (this.boxes.delete(id)) this.removed.push(id);
	}
	/** Add a box as if a crashed runner left it. */
	leftover(labels: Record<string, string>, name = "old") {
		const id = `left${++this.#n}`;
		this.boxes.set(id, { id, name, labels });
		return id;
	}
}
