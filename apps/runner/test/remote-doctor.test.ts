import { expect, test } from "bun:test";
import { applyFlags } from "../src/cli.ts";
import { defaultSettings } from "../src/config.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { DoctorReport } from "../src/doctor.ts";
import { doctorHandler, REMOTE_PROBE_REFUSED } from "../src/remote-doctor.ts";

const report = (deep: boolean): DoctorReport => ({
	runner: "laptop",
	at: "2026-11-11T10:00:00Z",
	deep,
	ok: true,
	steps: [
		{ id: "a", name: "config", status: "pass", ms: 1, detail: [] },
		{
			id: "e",
			name: "agent",
			status: deep ? "pass" : "skip",
			ms: 0,
			detail: deep ? ["agent answered: OK"] : ["skipped: run doctor --deep"],
		},
	],
});

test("a deep request runs step e only when the owner allows remote probes", async () => {
	const ran: boolean[] = [];
	const reports: DoctorReport[] = [];
	const opts = {
		account: "alice",
		runnerId: "laptop",
		run: async (deep: boolean) => {
			ran.push(deep);
			return report(deep);
		},
		onReport: (r: DoctorReport) => reports.push(r),
	};
	const refused = await doctorHandler({ ...opts, allowRemoteProbe: false })({
		deep: true,
	});
	expect(ran).toEqual([false]);
	expect(refused.steps.find((s) => s.id === "e")?.detail).toEqual([
		REMOTE_PROBE_REFUSED,
	]);
	const allowed = await doctorHandler({ ...opts, allowRemoteProbe: true })({
		deep: true,
	});
	expect(ran).toEqual([false, true]);
	expect(allowed.steps.find((s) => s.id === "e")?.status).toBe("pass");
	expect(reports).toHaveLength(2);
});

test("one doctor at a time", async () => {
	let release = () => {};
	const h = doctorHandler({
		account: "alice",
		runnerId: "laptop",
		allowRemoteProbe: false,
		run: () =>
			new Promise<DoctorReport>((r) => {
				release = () => r(report(false));
			}),
	});
	const first = h(null);
	await expect(h(null)).rejects.toMatchObject({ code: "conflict" });
	release();
	expect((await first).runner).toBe("laptop");
});

test("diagnostics keep the newest doctor report, redacted, in the snapshot", () => {
	const d = new Diagnostics(
		{
			id: "laptop",
			queues: [],
			capacity: 1,
			capabilities: [],
			providers: [],
			repos: {},
			agent: {},
			allowSetup: false,
		},
		"dev",
	);
	const r = report(false);
	r.steps[0]?.detail.push("token=abc123secret");
	d.doctor(r);
	d.doctor({ ...report(true), at: "2026-11-11T09:00:00Z" });
	const snap = d.snapshot();
	expect(snap.lastDoctor?.at).toBe("2026-11-11T10:00:00Z");
	expect(JSON.stringify(snap)).not.toContain("abc123secret");
});

test("--allow-remote-probe is a setting", () => {
	const s = applyFlags(defaultSettings("x"), {
		"allow-remote-probe": true,
	} as never);
	expect(s.allowRemoteProbe).toBe(true);
	expect(applyFlags(defaultSettings("x"), {} as never).allowRemoteProbe).toBe(
		undefined,
	);
});
