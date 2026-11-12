/**
 * The login gate's state on this machine (mm-210.81): `login-gate.json` next
 * to runner.json. A model credential the agent's provider refused, in a task
 * or in the box probe of `doctor --deep`, keeps the environments that need it
 * out of work (readiness.ts) until the value changes or a later box probe
 * passes. A file, so that a separate `doctor --deep` process can set it, and
 * so that it survives a runner restart. It holds the secret's NAME and a
 * sha256 of its value, never the value; it is never sent anywhere.
 */
import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DoctorReport } from "./doctor.ts";
import { providerLoginMessage } from "./launcher.ts";
import { type LoginRefused, loginRefusal } from "./readiness.ts";

export type GateState = {
	refused: LoginRefused | null;
	/** When it last changed (ISO): the newer state wins. */
	at: string;
};

export const gatePath = (configPath: string) =>
	join(dirname(configPath), "login-gate.json");

export async function readGate(configPath: string): Promise<GateState | null> {
	try {
		const s = (await Bun.file(gatePath(configPath)).json()) as GateState;
		return typeof s?.at === "string" ? s : null;
	} catch {
		return null;
	}
}

export async function writeGate(
	configPath: string,
	s: GateState,
): Promise<void> {
	const path = gatePath(configPath);
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, path);
}

/**
 * What a `doctor --deep` report says about the model credential the box
 * probe used: refused (step e failed with a provider login answer), passed
 * (step e answered), or nothing (no deep run, another failure, no box).
 */
export function probeOutcome(
	r: DoctorReport,
	model: { name: string; value: string } | null,
	modelSecrets: readonly string[],
): { refused: LoginRefused } | { passed: true } | null {
	if (!r.deep) return null;
	const e = r.steps.find((s) => s.id === "e");
	if (e?.status === "pass") return { passed: true };
	if (e?.status !== "fail" || !model) return null;
	const refused = loginRefusal(
		providerLoginMessage(e.problem ?? ""),
		{ [model.name]: model.value },
		modelSecrets,
		new Date(r.at),
	);
	return refused ? { refused } : null;
}

/**
 * Apply a box probe's outcome to the file: refused sets it, passed clears a
 * refusal older than the report. Returns the new state, or null (no change).
 */
export async function recordProbe(
	configPath: string,
	r: DoctorReport,
	model: { name: string; value: string } | null,
	modelSecrets: readonly string[],
): Promise<GateState | null> {
	const o = probeOutcome(r, model, modelSecrets);
	if (!o) return null;
	const now = new Date().toISOString();
	if ("refused" in o) {
		const s = { refused: o.refused, at: now };
		await writeGate(configPath, s);
		return s;
	}
	const prev = await readGate(configPath);
	if (!prev?.refused || prev.refused.at > r.at) return null;
	const s = { refused: null, at: now };
	await writeGate(configPath, s);
	return s;
}
