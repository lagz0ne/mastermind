import type { Bead } from "@mastermind/core";

const minutes = (now: Date, m: number) =>
	new Date(now.getTime() + m * 60_000).toISOString();

/**
 * Sample board for tests (the page reads GET /api/board since mm-210.7). Times are relative to
 * `now` so live and expired leases stay that way whenever it renders.
 */
export function fixtureBeads(now: Date = new Date()): Bead[] {
	const t = (m: number) => minutes(now, m);
	const base = { type: "task", blocked: false, createdAt: t(-600) };
	return [
		{
			...base,
			id: "mm-210.7",
			title: "api: board read model + live events",
			status: "open",
			priority: 1,
			type: "feature",
			labels: ["queue:api"],
			updatedAt: t(-30),
		},
		{
			...base,
			id: "mm-210.11",
			title: "telemetry: OTLP logs, traces, metrics to the Victoria stack",
			status: "open",
			priority: 2,
			labels: ["queue:ops"],
			updatedAt: t(-120),
		},
		{
			...base,
			id: "mm-210.13",
			title: "spike: Paseo Hub + Paseo inbox convergence",
			status: "open",
			priority: 2,
			labels: [],
			updatedAt: t(-90),
		},
		{
			...base,
			id: "mm-210.4",
			title: "web: Tailwind v4 + shadcn + TanStack Router foundation",
			description:
				"The UI stack proven in the Bun pipeline, with the kanban board on fixture data.",
			status: "in_progress",
			priority: 1,
			type: "feature",
			assignee: "rocky/paseo-bba7717",
			labels: ["queue:web"],
			lease: { expiresAt: t(25), heartbeatAt: t(-2) },
			updatedAt: t(-2),
		},
		{
			...base,
			id: "mm-210.3",
			title: "packages/work: work store on JetStream, journal tail",
			status: "in_progress",
			priority: 1,
			assignee: "rocky/paseo-1d648e6",
			labels: ["queue:core"],
			lease: { expiresAt: t(-5), heartbeatAt: t(-35) },
			updatedAt: t(-35),
		},
		{
			...base,
			id: "mm-210.6",
			title: "deploy: NATS with JetStream next to the app",
			status: "hooked",
			priority: 1,
			assignee: "rocky/paseo-975f6fc",
			labels: ["queue:ops"],
			lease: { expiresAt: t(40), heartbeatAt: t(-1) },
			updatedAt: t(-1),
		},
		{
			...base,
			id: "mm-210.8",
			title: "dispatch: hand a ready bead to a user agent",
			status: "open",
			priority: 1,
			blocked: true,
			labels: ["queue:api"],
			updatedAt: t(-200),
		},
		{
			...base,
			id: "mm-210.1",
			title: "DECISION: human approves the routing + dispatch model",
			status: "blocked",
			priority: 0,
			type: "decision",
			labels: [],
			updatedAt: t(-300),
		},
		{
			...base,
			id: "mm-210.2",
			title: "core: domain types for work",
			status: "closed",
			priority: 1,
			assignee: "rocky/paseo-2bb477a",
			labels: ["queue:core"],
			updatedAt: t(-60),
			closedAt: t(-60),
		},
		{
			...base,
			id: "mm-8xu",
			title: "doop: mastermind UI canvas, guidelines, live import",
			status: "closed",
			priority: 2,
			labels: ["queue:web"],
			updatedAt: t(-400),
			closedAt: t(-400),
		},
		{
			...base,
			id: "mm-9zz",
			title: "parked: someday, maybe",
			status: "deferred",
			priority: 4,
			labels: [],
			updatedAt: t(-900),
		},
	];
}
