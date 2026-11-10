// Pure parts of `bun deploy/dokploy.ts release <sha|latest>`: which image to pin, which
// Dokploy deployment is ours, and what the shared Dokploy queue is doing meanwhile.

const sha40 = /^[0-9a-f]{40}$/;

/** The image ref to deploy: the repo of the current image with the tag of `ref`. */
export function pinImage(current: string, ref: string): string {
	const repo = current
		.replace(/@sha256:[0-9a-f]+$/, "")
		.replace(/:[^/:]+$/, "");
	if (!repo) throw new Error("the app has no docker image to pin");
	if (ref === "latest") return `${repo}:latest`;
	if (!sha40.test(ref))
		throw new Error(
			`release needs a full 40-hex commit sha or 'latest', got '${ref}'`,
		);
	// docker/metadata-action `type=sha,format=long` tags each image sha-<40 hex>.
	return `${repo}:sha-${ref}`;
}

/** The title we give the deployment, so we can find our own record among the others. */
export const releaseTitle = (ref: string) =>
	`release ${ref === "latest" ? "latest" : ref.slice(0, 7)}`;

export type Deployment = {
	deploymentId: string;
	title: string;
	status: string;
	createdAt: string;
	errorMessage?: string | null;
};

/** Our deployment: the newest one with our title, created after we asked (with clock skew). */
export function findOurs(
	deployments: Deployment[],
	title: string,
	askedAt: number,
	skewMs = 60_000,
): Deployment | undefined {
	return deployments
		.filter(
			(d) => d.title === title && Date.parse(d.createdAt) >= askedAt - skewMs,
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export type QueueJob = {
	id: string;
	state: string;
	timestamp: number;
	data: { applicationId?: string; composeId?: string; titleLog?: string };
};

/**
 * One line about the shared Dokploy queue: it runs one deployment at a time for every
 * project, so an accepted deploy can wait behind other projects' builds.
 */
export function describeQueue(jobs: QueueJob[], applicationId: string): string {
	const waiting = jobs
		.filter((j) => j.state === "waiting" || j.state === "delayed")
		.sort((a, b) => a.timestamp - b.timestamp);
	const active = jobs.filter((j) => j.state === "active");
	const mine = waiting.findIndex((j) => j.data.applicationId === applicationId);
	const running = active
		.map((j) => (j.data.titleLog ?? j.id).split("\n")[0]?.slice(0, 60))
		.join("; ");
	const where =
		mine < 0
			? "ours is not waiting"
			: `ours waits behind ${mine} job${mine === 1 ? "" : "s"}`;
	return `dokploy queue: ${active.length} running${running ? ` (${running})` : ""}, ${waiting.length} waiting, ${where}`;
}
