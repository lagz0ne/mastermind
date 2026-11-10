import { describe, expect, test } from "bun:test";
import {
	BEAD_VERBS,
	beadToken,
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
});
