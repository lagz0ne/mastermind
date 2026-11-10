/**
 * Fixed-window counters per key, in memory (per replica). Enough to stop a
 * script from guessing login codes or the operator key.
 */
export class RateLimit {
	private readonly hits = new Map<string, { n: number; reset: number }>();

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly now: () => number = Date.now,
	) {}

	/** Count one hit for `key`; false when the key is over its limit. */
	take(key: string): boolean {
		const t = this.now();
		const h = this.hits.get(key);
		if (!h || h.reset <= t) {
			if (this.hits.size > 10_000) this.sweep(t);
			this.hits.set(key, { n: 1, reset: t + this.windowMs });
			return true;
		}
		h.n += 1;
		return h.n <= this.max;
	}

	private sweep(t: number) {
		for (const [k, h] of this.hits) if (h.reset <= t) this.hits.delete(k);
	}
}

/** The client address behind Cloudflare and Traefik, best effort. */
export function clientIp(req: Request): string {
	return (
		req.headers.get("cf-connecting-ip") ??
		req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"direct"
	);
}
