import { greet } from "@mastermind/core";

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	routes: {
		"/": () => new Response(greet("mastermind")),
		"/health": () => Response.json({ ok: true }),
	},
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		await server.stop();
		process.exit(0);
	});
}

console.log(`api listening on ${server.url}`);
