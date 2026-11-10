import type { Lease } from "@mastermind/core";
import { useEffect, useState } from "react";

/** live, expiring (under a minute left), expired, or none. */
export type LeaseLook = "none" | "live" | "expiring" | "expired";

export const EXPIRING_MS = 60_000;

export type LeaseView = {
	look: LeaseLook;
	/** Time left as m:ss, "0:00" once expired; "" without a lease. */
	left: string;
	/** Seconds since the last heartbeat; null without a lease. */
	beatAgoS: number | null;
};

export function clock(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function leaseView(lease: Lease | undefined, now: number): LeaseView {
	if (!lease) return { look: "none", left: "", beatAgoS: null };
	const ms = Date.parse(lease.expiresAt) - now;
	const look: LeaseLook =
		ms <= 0 ? "expired" : ms < EXPIRING_MS ? "expiring" : "live";
	return {
		look,
		left: clock(ms),
		beatAgoS: Math.max(
			0,
			Math.round((now - Date.parse(lease.heartbeatAt)) / 1000),
		),
	};
}

/** The current time, updated every `ms` while the component is mounted. */
export function useNow(ms = 1_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

/** "12 s", "4 min", "3 h", "2 d" since `iso`. */
export function ago(iso: string, now: number): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h`;
	return `${Math.floor(s / 86_400)} d`;
}
