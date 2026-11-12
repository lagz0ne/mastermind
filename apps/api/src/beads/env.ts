// Where a bead runs (DispatchEnv) is stored on the bead as labels, next to
// the queue label and the requirement labels the router already reads. The
// dispatcher reads them back with envOf; POST /api/beads writes them. An old
// `provider:` label is ignored: the runner picks the agent (mm-210.84).
import type { Bead, DispatchEnv, NewWork } from "@mastermind/core";
import { REQUIREMENT_LABEL_PREFIX, requirementsOf } from "@mastermind/router";

export const REPO_LABEL_PREFIX = "repo:";
export const REF_LABEL_PREFIX = "ref:";
export const DEFAULT_REF = "main";

function labelValue(bead: Pick<Bead, "labels">, prefix: string) {
	const label = bead.labels.find(
		(l) => l.startsWith(prefix) && l.length > prefix.length,
	);
	return label?.slice(prefix.length);
}

/** The labels that carry `env`. */
export function envLabels(env: NonNullable<NewWork["env"]>): string[] {
	const labels = [`${REPO_LABEL_PREFIX}${env.repo}`];
	labels.push(`${REF_LABEL_PREFIX}${env.ref || DEFAULT_REF}`);
	for (const r of env.requires ?? []) {
		labels.push(`${REQUIREMENT_LABEL_PREFIX}${r}`);
	}
	return labels;
}

/** The environment of a dispatch, read from the bead's labels. */
export function envOf(bead: Pick<Bead, "labels">): DispatchEnv {
	const env: DispatchEnv = {
		repo: labelValue(bead, REPO_LABEL_PREFIX) ?? "",
		ref: labelValue(bead, REF_LABEL_PREFIX) ?? DEFAULT_REF,
		requires: requirementsOf(bead),
	};
	return env;
}
