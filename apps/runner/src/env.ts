/**
 * `mastermind-runner env init [dir]` (mm-210.67): write
 * `.devcontainer/devcontainer.json` with a `customizations.mastermind` block
 * into a repo, from flags or a few questions, then validate it. Prior art: the
 * devcontainer spec (customizations.<tool>), `devcontainer templates apply`,
 * and Codespaces' top-level `secrets`.
 *
 * The block (design: docs/design/prior-art.html, section 1):
 *   secrets       names the box needs (required; values only on the runner)
 *   network       "open" | { "allow": ["host", "host:port", "*.host"] }
 *   output        { "kind": "pr" | "branch" | "none" }
 *   check         shell commands that must pass before the agent
 *   instructions  text added to every prompt
 * Today the runner reads `secrets` and `instructions` from the file; the
 * environment in Mastermind (/environments) sets network, output and check.
 * `env test` uses the file's values for all five.
 *
 * Idempotent: an existing file is merged (only the given values change); a
 * file with comments is not rewritten without --force (comments would go).
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	type EnvironmentNetwork,
	type EnvironmentOutput,
	OUTPUT_KINDS,
} from "@mastermind/core";
import {
	cleanConfig,
	type DevcontainerConfig,
	DevcontainerError,
	parseConfig,
} from "./box/devcontainer.ts";
import { parseAllow } from "./box/proxy.ts";
import { isSecretName } from "./secrets/store.ts";

/** A base image with glibc (the Mastermind layer copies node into it). */
export const DEFAULT_DEVCONTAINER_IMAGE =
	"mcr.microsoft.com/devcontainers/base:ubuntu";

export const CONFIG_PATHS = [
	".devcontainer/devcontainer.json",
	".devcontainer.json",
] as const;

export type MastermindBlock = {
	secrets?: string[];
	network?: EnvironmentNetwork;
	output?: EnvironmentOutput;
	check?: string[];
	instructions?: string;
};

export type InitOptions = {
	image?: string;
	secrets?: string[];
	network?: EnvironmentNetwork;
	output?: EnvironmentOutput["kind"];
	check?: string[];
	postCreate?: string;
	instructions?: string;
	force?: boolean;
};

export type Validation = {
	ok: boolean;
	errors: string[];
	warnings: string[];
	block: MastermindBlock;
};

export class EnvInitError extends Error {
	override name = "EnvInitError";
}

/** The config file of a repo dir (spec lookup), or null. */
export async function findLocalConfig(dir: string): Promise<string | null> {
	for (const p of CONFIG_PATHS)
		if (await Bun.file(join(dir, p)).exists()) return join(dir, p);
	return null;
}

/** `--network`: open, or a comma list of hosts (an allow list). */
export function parseNetwork(v: string): EnvironmentNetwork {
	const t = v.trim();
	if (t === "open") return t;
	const list = parseAllow(
		t
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	if (typeof list === "string") throw new EnvInitError(list);
	return { allow: list };
}

const strings = (v: unknown): string[] | null =>
	Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null;

/** The block as the file has it (no checks). */
export function blockOf(config: DevcontainerConfig): MastermindBlock {
	const c = config.customizations as Record<string, unknown> | undefined;
	const mm = c?.mastermind;
	return mm && typeof mm === "object" && !Array.isArray(mm)
		? (mm as MastermindBlock)
		: {};
}

/**
 * Check a devcontainer.json the way the runner will use it: JSONC, image or
 * build, no Compose, the host fields that will be removed, and the block.
 */
export function validateDevcontainer(text: string, where: string): Validation {
	const errors: string[] = [];
	const warnings: string[] = [];
	let config: DevcontainerConfig;
	try {
		config = parseConfig(text, where);
	} catch (error) {
		return { ok: false, errors: [msg(error)], warnings, block: {} };
	}
	try {
		const c = cleanConfig(config);
		if (c.removed.length)
			warnings.push(
				`not applied in a box (they reach the host): ${c.removed.join(", ")}`,
			);
	} catch (error) {
		errors.push(msg(error));
	}
	const image = typeof config.image === "string" ? config.image : "";
	if (/alpine/i.test(image))
		errors.push(
			`image ${image}: Alpine has no glibc; the Mastermind layer needs it (use a Debian or Ubuntu image)`,
		);
	const raw = (config.customizations as Record<string, unknown> | undefined)
		?.mastermind;
	if (raw === undefined)
		warnings.push(
			"no customizations.mastermind block (the box gets no secrets from the file)",
		);
	else if (!raw || typeof raw !== "object" || Array.isArray(raw))
		errors.push("customizations.mastermind is not an object");
	const b = blockOf(config);
	if (b.secrets !== undefined) {
		const s = strings(b.secrets);
		if (!s) errors.push("customizations.mastermind.secrets: a list of names");
		else
			for (const n of s)
				if (!isSecretName(n))
					errors.push(
						`secret name ${JSON.stringify(n)}: letters, digits and '_' only`,
					);
	}
	if (b.network !== undefined) {
		const n = b.network as unknown;
		if (n !== "open") {
			const allow = strings((n as { allow?: unknown })?.allow);
			const list = allow ? parseAllow(allow) : "not a list";
			if (typeof list === "string")
				errors.push(
					`customizations.mastermind.network: "open" or {"allow": [...]} (${list})`,
				);
		}
	}
	if (b.output !== undefined) {
		const k = (b.output as { kind?: unknown })?.kind;
		if (!OUTPUT_KINDS.includes(k as EnvironmentOutput["kind"]))
			errors.push(
				`customizations.mastermind.output.kind: one of ${OUTPUT_KINDS.join(", ")}`,
			);
	}
	if (b.check !== undefined && !strings(b.check))
		errors.push("customizations.mastermind.check: a list of shell commands");
	if (b.instructions !== undefined && typeof b.instructions !== "string")
		errors.push("customizations.mastermind.instructions: text");
	return { ok: errors.length === 0, errors, warnings, block: b };
}

/** The new file text: the existing config (or a new one) with the given values. */
export function mergeConfig(
	existing: DevcontainerConfig | null,
	o: InitOptions,
	name: string,
): DevcontainerConfig {
	const out: DevcontainerConfig = existing
		? { ...existing }
		: { name, image: o.image ?? DEFAULT_DEVCONTAINER_IMAGE };
	if (existing && o.image) {
		out.image = o.image;
		delete out.build;
	}
	if (o.postCreate) out.postCreateCommand = o.postCreate;
	const customizations = {
		...((out.customizations as Record<string, unknown> | undefined) ?? {}),
	};
	const mm: MastermindBlock = { ...blockOf(out) };
	if (o.secrets?.length)
		mm.secrets = [...new Set([...(mm.secrets ?? []), ...o.secrets])];
	else mm.secrets ??= [];
	if (o.network !== undefined) mm.network = o.network;
	else mm.network ??= "open";
	if (o.output) mm.output = { kind: o.output };
	else mm.output ??= { kind: "pr" };
	if (o.check?.length) mm.check = o.check;
	if (o.instructions) mm.instructions = o.instructions;
	customizations.mastermind = mm;
	out.customizations = customizations;
	return out;
}

export type InitResult = {
	path: string;
	/** created, updated, or unchanged (idempotent re-run). */
	action: "created" | "updated" | "unchanged";
	validation: Validation;
};

/** Write (or merge into) the repo's devcontainer.json, then validate it. */
export async function initEnvironment(
	dir: string,
	o: InitOptions,
): Promise<InitResult> {
	const root = resolve(dir);
	const found = await findLocalConfig(root);
	const path = found ?? join(root, CONFIG_PATHS[0]);
	let existing: DevcontainerConfig | null = null;
	let before = "";
	if (found) {
		before = await Bun.file(found).text();
		try {
			existing = parseConfig(before, found);
		} catch (error) {
			throw new EnvInitError(
				`${msg(error)}; fix the file, or move it away and run env init again`,
			);
		}
	}
	const next = mergeConfig(existing, o, basename(root));
	const text = `${JSON.stringify(next, null, "\t")}\n`;
	const same = existing && JSON.stringify(next) === JSON.stringify(existing);
	if (same)
		return {
			path,
			action: "unchanged",
			validation: validateDevcontainer(before, path),
		};
	if (found && hasComments(before) && !o.force)
		throw new EnvInitError(
			`${found} has comments; env init would lose them. Add this block by hand, or pass --force:\n"customizations": ${JSON.stringify(next.customizations, null, 2)}`,
		);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, text);
	await rename(tmp, path);
	return {
		path,
		action: found ? "updated" : "created",
		validation: validateDevcontainer(text, path),
	};
}

/** JSONC comments outside strings. */
export function hasComments(text: string): boolean {
	let inStr = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
			return true;
	}
	return false;
}

const msg = (e: unknown) =>
	e instanceof DevcontainerError || e instanceof Error ? e.message : String(e);
