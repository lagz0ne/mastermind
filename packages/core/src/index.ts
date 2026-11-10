/** Shape of `GET /api/health`, shared by the api and the web UI. */
export type Health = {
	ok: boolean;
	version: string;
	db: "up" | "down" | "unconfigured";
};

export function isHealthy(db: Health["db"]): boolean {
	return db !== "down";
}
