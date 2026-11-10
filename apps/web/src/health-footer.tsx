import type { Health } from "@mastermind/core";
import { useEffect, useState } from "react";

export function HealthFooter() {
	const [health, setHealth] = useState<Health | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		fetch("/api/health")
			.then((res) => res.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setFailed(true));
	}, []);

	return (
		<footer className="border-t px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
			{failed
				? "api unreachable"
				: health
					? `api ${health.ok ? "ok" : "degraded"} · work ${health.work} · ${health.version.slice(0, 7)}`
					: "…"}
		</footer>
	);
}
