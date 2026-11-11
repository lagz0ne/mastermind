// Which commit the NATS redeploy decision compares with (mm-210.38).
//
// CI used to compare deploy/nats with the commit the APP serves. When the app
// lagged behind (a pinned image, a jammed Dokploy queue), an old deploy/nats
// change counted as new on every run, every run posted the NATS hook again, and
// those queued jobs restarted NATS hours later. Now the base is the head commit
// of the newest earlier CI run whose redeploy step succeeded: that run already
// asked for every NATS change up to its commit. Each change is posted once.
//
// CLI (in the deploy job): prints the base sha, or nothing when no earlier run
// is found (then CI does not redeploy NATS; a human redeploys it in Dokploy).
//   GITHUB_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID [GITHUB_API_URL] bun deploy/src/nats-base.ts

/** Start of the name of the deploy job's step that posts the hooks (.github/workflows/ci.yml). */
export const REDEPLOY_STEP = "Redeploy what changed";
export const DEPLOY_JOB = "deploy";

export type Run = {
	id: number;
	head_sha: string;
	created_at: string;
	head_branch: string;
};
export type Job = {
	name: string;
	steps?: { name: string; conclusion: string | null }[];
};

export type GitHub = {
	/** Runs of the workflow, newest first. */
	runs(): Promise<Run[]>;
	jobs(runId: number): Promise<Job[]>;
};

/** Head sha of the newest run before `current` whose redeploy step succeeded. */
export async function natsBase(
	gh: GitHub,
	current: { id: number; branch: string },
	maxRuns = 30,
): Promise<string | null> {
	const runs = await gh.runs();
	const me = runs.find((r) => r.id === current.id);
	const earlier = runs
		.filter(
			(r) =>
				r.id !== current.id &&
				r.head_branch === current.branch &&
				(!me || r.created_at < me.created_at),
		)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))
		.slice(0, maxRuns);
	for (const run of earlier) {
		const deploy = (await gh.jobs(run.id)).find((j) => j.name === DEPLOY_JOB);
		const step = deploy?.steps?.find((s) => s.name.startsWith(REDEPLOY_STEP));
		if (step?.conclusion === "success") return run.head_sha;
	}
	return null;
}

function github(env: Record<string, string | undefined>): GitHub {
	const api = env.GITHUB_API_URL ?? "https://api.github.com";
	const repo = env.GITHUB_REPOSITORY;
	const token = env.GITHUB_TOKEN;
	if (!repo || !token)
		throw new Error("needs GITHUB_REPOSITORY and GITHUB_TOKEN");
	const get = async <T>(path: string): Promise<T> => {
		const res = await fetch(`${api}/repos/${repo}${path}`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
		return (await res.json()) as T;
	};
	return {
		runs: async () => {
			const runId = env.GITHUB_RUN_ID;
			const me = await get<{ workflow_id: number }>(`/actions/runs/${runId}`);
			return (
				await get<{ workflow_runs: Run[] }>(
					`/actions/workflows/${me.workflow_id}/runs?per_page=50`,
				)
			).workflow_runs;
		},
		jobs: async (runId) =>
			(await get<{ jobs: Job[] }>(`/actions/runs/${runId}/jobs?per_page=50`))
				.jobs,
	};
}

if (import.meta.main) {
	const env = process.env;
	const base = await natsBase(github(env), {
		id: Number(env.GITHUB_RUN_ID),
		branch: env.GITHUB_REF_NAME ?? "main",
	});
	if (base) console.log(base);
}
