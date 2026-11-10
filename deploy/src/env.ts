// Dokploy stores a service's environment as one KEY=VALUE text block.
// These helpers read it, add what is missing, and never drop what is there.

export type Env = Map<string, string>;

export function parseEnv(text: string | null | undefined): Env {
	const env: Env = new Map();
	for (const line of (text ?? "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		env.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
	}
	return env;
}

export function serializeEnv(env: Env): string {
	return [...env].map(([key, value]) => `${key}=${value}`).join("\n");
}

/** A value, or a function that makes one. Functions run only for missing keys. */
export type Wanted = Record<string, string | (() => string)>;

/**
 * `keep`: existing keys win, only missing keys are added (use for secrets, so
 * a second apply never rotates a password). `set`: these values always win.
 * `drop`: these keys are removed. Keys in none of them stay as they are.
 * Returns the names of the keys that changed.
 */
export function mergeEnv(
	current: Env,
	wanted: { keep?: Wanted; set?: Record<string, string>; drop?: string[] },
): { env: Env; changed: string[] } {
	const env: Env = new Map(current);
	const changed: string[] = [];
	for (const [key, value] of Object.entries(wanted.keep ?? {})) {
		if (env.has(key)) continue;
		env.set(key, typeof value === "function" ? value() : value);
		changed.push(key);
	}
	for (const [key, value] of Object.entries(wanted.set ?? {})) {
		if (env.get(key) === value) continue;
		env.set(key, value);
		changed.push(key);
	}
	for (const key of wanted.drop ?? []) {
		if (env.delete(key)) changed.push(key);
	}
	return { env, changed };
}
