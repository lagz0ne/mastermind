/**
 * The runner's local secret store (mm-210.51): ONE file next to the runner
 * config, `~/.config/mastermind/secrets` (or `$MASTERMIND_RUNNER_SECRETS`),
 * mode 0600 in a 0700 directory, JSON `{ "NAME": "value" }`, written
 * atomically (temp file + rename). Values never leave this machine: they go
 * only into the agent's environment (later: the box) at start.
 */
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, configPath } from "../config.ts";

/** A secret name: letters, digits and '_', not starting with a digit. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretName(name: string): boolean {
	return SECRET_NAME.test(name);
}

/** `$MASTERMIND_RUNNER_SECRETS`, else `secrets` next to the runner config. */
export function secretsPath(
	env: Record<string, string | undefined> = process.env,
): string {
	if (env.MASTERMIND_RUNNER_SECRETS) return env.MASTERMIND_RUNNER_SECRETS;
	return join(dirname(configPath(env)), "secrets");
}

/** Where secret values come from; the file store is one, tests use a map. */
export interface SecretSource {
	/** Every stored name and value. */
	load(): Promise<Record<string, string>>;
}

/** A source with fixed values (tests, or no store). */
export function memorySecrets(
	values: Record<string, string> = {},
): SecretSource {
	return { load: async () => ({ ...values }) };
}

export class SecretStore implements SecretSource {
	constructor(readonly path: string) {}

	async load(): Promise<Record<string, string>> {
		const f = Bun.file(this.path);
		if (!(await f.exists())) return {};
		const st = await stat(this.path);
		if (st.mode & 0o077)
			throw new ConfigError(
				`secrets file ${this.path} can be read by other users; run: chmod 600 ${this.path}`,
			);
		let v: unknown;
		try {
			v = JSON.parse(await f.text());
		} catch {
			throw new ConfigError(`secrets file ${this.path} is not JSON`);
		}
		if (!v || typeof v !== "object" || Array.isArray(v))
			throw new ConfigError(`secrets file ${this.path} is not an object`);
		const out: Record<string, string> = {};
		for (const [k, x] of Object.entries(v))
			if (isSecretName(k) && typeof x === "string") out[k] = x;
		return out;
	}

	async names(): Promise<string[]> {
		return Object.keys(await this.load()).sort();
	}

	async set(name: string, value: string): Promise<void> {
		if (!isSecretName(name))
			throw new ConfigError(
				`bad secret name ${name}: letters, digits and '_' only`,
			);
		if (!value) throw new ConfigError(`no value for ${name}`);
		const all = await this.load();
		all[name] = value;
		await this.#write(all);
	}

	/** True when the name was stored. */
	async unset(name: string): Promise<boolean> {
		const all = await this.load();
		if (!(name in all)) return false;
		delete all[name];
		await this.#write(all);
		return true;
	}

	async #write(all: Record<string, string>): Promise<void> {
		const dir = dirname(this.path);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.${process.pid}.tmp`;
		await rm(tmp, { force: true });
		await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await chmod(tmp, 0o600);
		await rename(tmp, this.path);
	}
}
