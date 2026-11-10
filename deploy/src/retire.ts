// Find the services of site.json "retired" in a Dokploy project environment.
//
// project.all does not give every service the same fields: a postgres entry there has its
// postgresId but no name. So an entry without a name is read again with `<kind>.one`, and a
// service matches by its name or its appName.

export type RetiredKind = "compose" | "postgres" | "application";

export const ID_KEY: Record<RetiredKind, string> = {
	compose: "composeId",
	postgres: "postgresId",
	application: "applicationId",
};

/** What a service entry may carry, in project.all or in `<kind>.one`. */
export type ServiceEntry = {
	name?: string | null;
	appName?: string | null;
	composeStatus?: string | null;
	applicationStatus?: string | null;
	[key: string]: unknown;
};

/** The service lists of one project environment, as project.all gives them. */
export type EnvServices = {
	compose?: ServiceEntry[];
	postgres?: ServiceEntry[];
	applications?: ServiceEntry[];
};

/** Reads one service by kind and id (Dokploy `<kind>.one`). */
export type ReadOne = (kind: RetiredKind, id: string) => Promise<ServiceEntry>;

export type Retired = {
	/** The name from site.json "retired". */
	name: string;
	kind: RetiredKind;
	id: string;
	status: string;
};

const LISTS: [RetiredKind, keyof EnvServices][] = [
	["compose", "compose"],
	["postgres", "postgres"],
	["application", "applications"],
];

const statusOf = (e: ServiceEntry) =>
	e.composeStatus ?? e.applicationStatus ?? "unknown";

/** Every service whose name or appName is in `names`. Errors of readOne propagate. */
export async function findRetired(
	names: string[],
	env: EnvServices,
	readOne: ReadOne,
): Promise<Retired[]> {
	if (!names.length) return [];
	const found: Retired[] = [];
	for (const [kind, list] of LISTS) {
		for (const listed of env[list] ?? []) {
			const id = listed[ID_KEY[kind]];
			if (typeof id !== "string" || !id) continue;
			const entry = listed.name
				? listed
				: { ...listed, ...(await readOne(kind, id)) };
			const name = names.find((n) => n === entry.name || n === entry.appName);
			if (name) found.push({ name, kind, id, status: statusOf(entry) });
		}
	}
	return found;
}
