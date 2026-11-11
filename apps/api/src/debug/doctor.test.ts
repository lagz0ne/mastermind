import { expect, test } from "bun:test";
import { BusError, decode, encode } from "@mastermind/bus";
import { remoteDoctor } from "./doctor.ts";

test("requests the runner's doctor with a reply subject the runner may publish to", async () => {
	const seen: { subject: string; body: unknown; reply?: string }[] = [];
	const nc = {
		request: async (
			subject: string,
			data?: Uint8Array,
			opts?: { reply?: string; noMux?: boolean },
		) => {
			seen.push({
				subject,
				body: decode(data as Uint8Array),
				reply: opts?.reply,
			});
			expect(opts?.noMux).toBe(true);
			return { data: encode({ result: { ok: true } }) };
		},
	};
	const doctor = remoteDoctor(async () => nc as never);
	expect(await doctor("alice", "laptop.local", true)).toEqual({ ok: true });
	expect(seen[0]?.subject).toBe("mm.u.alice.r.laptop_local.doctor");
	expect(seen[0]?.body).toEqual({ deep: true });
	expect(seen[0]?.reply).toStartWith("mm.u.alice.r.laptop_local.doctor.reply.");
});

test("a bad account is a bad request; the runner's error comes back as a BusError", async () => {
	const doctor = remoteDoctor(
		async () =>
			({
				request: async () => ({
					data: encode({
						error: { code: "conflict", message: "a doctor is running" },
					}),
				}),
			}) as never,
	);
	await expect(doctor("a.b", "x", false)).rejects.toMatchObject({
		code: "bad_request",
	});
	const err = (await doctor("alice", "x", false).catch((e) => e)) as BusError;
	expect(err).toBeInstanceOf(BusError);
	expect(err.code).toBe("conflict");
});
