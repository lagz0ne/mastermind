import { describe, expect, test } from "bun:test";
import {
	BEAD_VERBS,
	beadToken,
	FILES_VERBS,
	parseSubject,
	patterns,
	SubjectError,
	subjects,
	token,
} from "./subjects.ts";

describe("subjects", () => {
	test("build the v0 subjects", () => {
		expect(subjects.next("alice", "backend")).toBe("mm.u.alice.q.backend.next");
		expect(subjects.bead("alice", "mm-7", "heartbeat")).toBe(
			"mm.u.alice.d.mm-7.heartbeat",
		);
		expect(subjects.ready("backend")).toBe("mm.q.backend.ready");
		expect(subjects.beadEvent("mm-7")).toBe("mm.events.bead.mm-7");
		expect(subjects.accountScope("alice")).toBe("mm.u.alice.>");
	});

	test("child bead ids keep one token: '.' is written as '~'", () => {
		expect(subjects.bead("alice", "mm-210.14", "report")).toBe(
			"mm.u.alice.d.mm-210~14.report",
		);
		expect(subjects.beadEvent("mm-210.14.2")).toBe(
			"mm.events.bead.mm-210~14~2",
		);
	});

	test.each(["", "a.b", "a*", ">", "a b", "a\tb", "a~b"])(
		"reject token %p",
		(bad) => {
			expect(() => token("account", bad)).toThrow(SubjectError);
			expect(() => subjects.next(bad, "q")).toThrow(SubjectError);
			expect(() => subjects.next("u", bad)).toThrow(SubjectError);
			expect(() => subjects.ready(bad)).toThrow(SubjectError);
		},
	);

	test.each(["", "mm-1*", "mm>1", "mm 1", "mm~1", ".mm", "mm.", "mm..1"])(
		"reject bead id %p",
		(bad) => {
			expect(() => beadToken(bad)).toThrow(SubjectError);
			expect(() => subjects.bead("u", bad, "complete")).toThrow(SubjectError);
		},
	);

	test("parse round-trips every builder", () => {
		expect(parseSubject(subjects.next("alice", "web"))).toEqual({
			kind: "next",
			account: "alice",
			queue: "web",
		});
		for (const verb of BEAD_VERBS) {
			expect(parseSubject(subjects.bead("bob", "mm-210.14", verb))).toEqual({
				kind: "bead",
				account: "bob",
				bead: "mm-210.14",
				verb,
			});
		}
		for (const verb of FILES_VERBS) {
			expect(parseSubject(subjects.files("bob", "mm-210.14", verb))).toEqual({
				kind: "files",
				account: "bob",
				bead: "mm-210.14",
				verb,
			});
		}
		expect(subjects.files("bob", "mm-210.14", "stage")).toBe(
			"mm.u.bob.f.mm-210~14.stage",
		);
		expect(parseSubject("mm.u.bob.f.mm-1.explode")).toBeNull();
		expect(parseSubject(subjects.ready("web"))).toEqual({
			kind: "ready",
			queue: "web",
		});
		expect(parseSubject(subjects.beadEvent("mm-3.1"))).toEqual({
			kind: "beadEvent",
			bead: "mm-3.1",
		});
	});

	test.each([
		"",
		"foo.bar",
		"mm",
		"mm.u.alice.q.backend",
		"mm.u.alice.q.backend.next.extra",
		"mm.u.alice.d.mm-1.explode",
		"mm.u.*.q.*.next",
		"mm.u.al~ice.q.backend.next",
		"mm.q.backend.notready",
		"mm.events.bead",
		"mm.events.bead.mm-1.x",
	])("parse rejects %p", (s) => {
		expect(parseSubject(s)).toBeNull();
	});

	test("patterns match their builders' shape", () => {
		const shape = (s: string) => s.split(".").length;
		expect(shape(patterns.next)).toBe(shape(subjects.next("a", "b")));
		expect(shape(patterns.bead("release"))).toBe(
			shape(subjects.bead("a", "b.1", "release")),
		);
		expect(shape(patterns.ready)).toBe(shape(subjects.ready("a")));
		expect(shape(patterns.beadEvents)).toBe(shape(subjects.beadEvent("a.1")));
	});

	test("runner status: one token for the runner id, parse gives it back", () => {
		expect(subjects.runnerStatus("alice", "laptop.local")).toBe(
			"mm.u.alice.r.laptop_local.status",
		);
		expect(parseSubject("mm.u.alice.r.laptop_local.status")).toEqual({
			kind: "runnerStatus",
			account: "alice",
			runner: "laptop_local",
		});
		expect(patterns.runnerStatus.split(".").length).toBe(
			subjects.runnerStatus("a", "b").split(".").length,
		);
		expect(() => subjects.runnerStatus("a.b", "x")).toThrow();
		expect(subjects.runnerDoctor("alice", "laptop.local")).toBe(
			"mm.u.alice.r.laptop_local.doctor",
		);
		expect(subjects.runnerDoctorScope("alice")).toBe("mm.u.alice.r.*.doctor");
		expect(subjects.runnerDoctorReply("alice", "laptop", "n1")).toBe(
			"mm.u.alice.r.laptop.doctor.reply.n1",
		);
	});

	test("direct offers: one subject per runner, reply inside the account scope", () => {
		expect(subjects.runnerOffer("alice", "laptop.local")).toBe(
			"mm.u.alice.r.laptop_local.offer",
		);
		expect(subjects.runnerOfferScope("alice")).toBe("mm.u.alice.r.*.offer");
		expect(subjects.runnerOfferReply("alice", "laptop", "n1")).toBe(
			"mm.u.alice.r.laptop.offer.reply.n1",
		);
		expect(
			subjects
				.runnerOfferReply("alice", "laptop", "n1")
				.startsWith("mm.u.alice."),
		).toBe(true);
		expect(parseSubject(subjects.runnerOffer("alice", "laptop"))).toBeNull();
		expect(() => subjects.runnerOffer("a.b", "x")).toThrow(SubjectError);
	});
});
