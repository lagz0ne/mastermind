import type { Health } from "@mastermind/core";
import { useEffect, useState } from "react";

export function App() {
	const [health, setHealth] = useState<Health | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		fetch("/api/health")
			.then((res) => res.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setFailed(true));
	}, []);

	return (
		<main>
			<h1>mastermind</h1>
			<p className="status">
				{failed
					? "api unreachable"
					: health
						? `api ${health.ok ? "ok" : "degraded"} · db ${health.db} · ${health.version.slice(0, 7)}`
						: "…"}
			</p>
		</main>
	);
}
