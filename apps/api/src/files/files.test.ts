import { describe, expect, test } from "bun:test";
import { attachment, filesRoutes } from "./routes.ts";
import {
	assigneeAccount,
	filesConfigFromEnv,
	objectName,
	safeFileName,
} from "./service.ts";

const MiB = 1024 * 1024;

describe("file names", () => {
	test.each([
		["report.pdf", "report.pdf"],
		["../../etc/passwd", "passwd"],
		["C:\\Users\\x\\a b.txt", "a b.txt"],
		["日本語.md", "日本語.md"],
		["a;b|c$.sh", "a_b_c_.sh"],
		["..", null],
		["", null],
		["dir/", null],
	])("%p -> %p", (raw, want) => {
		expect(safeFileName(raw)).toBe(want);
	});

	test("object names and the claim account", () => {
		expect(objectName("mm-1.2", "in", "a.txt")).toBe("mm-1.2/in/a.txt");
		expect(assigneeAccount({ assignee: "alice/laptop" })).toBe("alice");
		expect(assigneeAccount({ assignee: "local" })).toBeNull();
		expect(assigneeAccount({})).toBeNull();
	});

	test("attachment header keeps a UTF-8 name and an ASCII fallback", () => {
		expect(attachment('日本 "x".md')).toBe(
			`attachment; filename="__ _x_.md"; filename*=UTF-8''${encodeURIComponent('日本 "x".md')}`,
		);
	});
});

test("config from env: defaults and overrides", () => {
	expect(filesConfigFromEnv({})).toEqual({
		maxObjectBytes: 512 * MiB,
		inputsBytes: 2048 * MiB,
		accountBytes: 1024 * MiB,
		outputTtlMs: 30 * 24 * 60 * 60 * 1000,
	});
	expect(
		filesConfigFromEnv({
			MM_FILES_MAX_OBJECT_MIB: "64",
			MM_FILES_ACCOUNT_MIB: "nope",
			MM_FILES_OUTPUT_TTL_DAYS: "7",
		}),
	).toMatchObject({
		maxObjectBytes: 64 * MiB,
		accountBytes: 1024 * MiB,
		outputTtlMs: 7 * 24 * 60 * 60 * 1000,
	});
});

describe("routes without NATS", () => {
	const req = (path: string, init?: RequestInit) =>
		Object.assign(new Request(`http://x${path}`, init), {
			params: { id: "mm-1" },
		});

	test("the session check comes first; then 503 while files are not ready", async () => {
		const denied = filesRoutes({
			files: () => null,
			beads: null,
			requireAccount: async () => new Response(null, { status: 401 }),
		});
		expect(
			(await denied["/api/items/:id/files"].GET(req("/api/items/mm-1/files")))
				.status,
		).toBe(401);
		const starting = filesRoutes({
			files: () => null,
			beads: null,
			requireAccount: async () => "bob",
		});
		const r = await starting["/api/items/:id/files"].POST(
			req("/api/items/mm-1/files?name=a", { method: "POST", body: "x" }),
		);
		expect(r.status).toBe(503);
	});
});
