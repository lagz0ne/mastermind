/**
 * `mastermind-runner onboard [<enrol token>]` (mm-210.59): the client side of
 * onboarding a worker. It runs the steps in order and stops at the first
 * FAIL with the line that fixes it; it can be run again (an enrolled runner
 * skips the enrol step). Only the last step marks the runner READY (config
 * `onboardedAt`); before that `start` asks for no work.
 *
 *   1. local checks, no credential: box engine (found by itself, else the
 *      install link for this OS: onboard-box.ts; gVisor noted), Paseo daemon,
 *      providers, default box image (pull)
 *   2. enroll (spends the token)
 *   3. credentials, LOCAL only (onboard-credentials.ts): Claude (setup-token
 *      or API key), git (GitHub App from the manifest, or a fine-grained token)
 *   4. needed secret NAMES of its environments; ask for each missing value
 *      (hidden prompt or stdin, never argv)
 *   5. doctor --deep (a real box: make, check, delete; one real probe agent)
 *   6. READY
 */

/** The result of one step. */
export type StepResult =
	| { ok: true; detail?: string }
	| { ok: false; problem: string; fix: string };

export type OnboardStep = {
	name: string;
	run: () => Promise<StepResult>;
};

export const pass = (detail?: string): StepResult =>
	detail ? { ok: true, detail } : { ok: true };
export const fail = (problem: string, fix: string): StepResult => ({
	ok: false,
	problem,
	fix,
});

/**
 * Run the steps in order; stop at the first FAIL (or throw). True when all
 * passed. A step that throws fails with its message.
 */
export async function runOnboard(
	steps: OnboardStep[],
	out: (line: string) => void,
	record?: (name: string, r: StepResult) => void,
): Promise<boolean> {
	for (const [i, step] of steps.entries()) {
		let r: StepResult;
		try {
			r = await step.run();
		} catch (error) {
			r = fail(
				error instanceof Error ? error.message : String(error),
				"fix the problem above, then run onboard again",
			);
		}
		record?.(step.name, r);
		const n = `${i + 1}/${steps.length}`;
		if (r.ok) {
			out(`✓ ${n} ${step.name}${r.detail ? `: ${r.detail}` : ""}`);
			continue;
		}
		out(`✗ ${n} ${step.name}: ${r.problem}`);
		out(`  fix: ${r.fix}`);
		out(
			"NOT READY: this runner asks for no work until onboard passes. Run onboard again after the fix.",
		);
		return false;
	}
	return true;
}
