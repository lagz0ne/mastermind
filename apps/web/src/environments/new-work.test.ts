import { expect, test } from "bun:test";
import { emptyForm, toNewWork } from "../work/new-work-dialog.tsx";

test("New work with an environment: label env:<name>, a typed ref overrides", () => {
	const w = toNewWork({
		...emptyForm,
		title: "t",
		labels: "api env:old",
		environment: "scratch",
		repo: "ignored",
		ref: "feat-x",
	});
	expect(w.labels).toEqual(["api", "env:scratch", "ref:feat-x"]);
	expect(w.env).toBeUndefined();
});

test("New work without an environment keeps repo and ref", () => {
	const w = toNewWork({ ...emptyForm, title: "t", repo: "https://x/y.git" });
	expect(w.env).toEqual({ repo: "https://x/y.git" });
	expect(w.labels).toEqual([]);
});
