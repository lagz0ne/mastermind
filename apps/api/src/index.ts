import index from "@mastermind/web/index.html";
import { SQL } from "bun";
import { health } from "./app.ts";

const version = process.env.GIT_SHA ?? "dev";
const sql = process.env.DATABASE_URL ? new SQL(process.env.DATABASE_URL) : null;

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	development: process.env.NODE_ENV !== "production",
	routes: {
		"/api/health": () => health(sql, version),
		"/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
		"/*": index,
	},
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		await server.stop();
		await sql?.close();
		process.exit(0);
	});
}

console.log(`mastermind ${version} listening on ${server.url}`);
