import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BOX_IMAGE_HASH,
	BOX_IMAGE_REPO,
	boxImageHash,
	DEFAULT_BOX_IMAGE,
	QUIET_PASEO_ENV,
} from "../../src/box/image.ts";

const root = join(import.meta.dir, "../../../..");
const dockerfile = readFileSync(join(root, "apps/runner/box/Dockerfile"));
const text = dockerfile.toString("utf8");

describe("default box image", () => {
	test("the tag is the hash of the Dockerfile (change it in image.ts when the Dockerfile changes)", () => {
		const hash = boxImageHash(dockerfile);
		if (hash !== BOX_IMAGE_HASH)
			throw new Error(
				`apps/runner/box/Dockerfile changed: set BOX_IMAGE_HASH = "${hash}" in apps/runner/src/box/image.ts`,
			);
		expect(DEFAULT_BOX_IMAGE).toBe(`${BOX_IMAGE_REPO}:box-${hash}`);
	});

	test("same hash as sha256sum | cut -c1-12 (what CI computes)", () => {
		expect(boxImageHash("x\n")).toBe("73cb3858a687");
		expect(boxImageHash(new TextEncoder().encode("x\n"))).toBe("73cb3858a687");
	});

	test("Paseo base, pinned Claude Code and bun, quiet daemon, no self update", () => {
		expect(text).toMatch(/^FROM ghcr\.io\/getpaseo\/paseo:\d+\.\d+\.\d+$/m);
		expect(text).toMatch(/@anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
		expect(text).toMatch(/\bbun@\d+\.\d+\.\d+/);
		for (const [k, v] of Object.entries(QUIET_PASEO_ENV))
			expect(text).toContain(`${k}=${v}`);
		expect(text).toContain("DISABLE_AUTOUPDATER=1");
		// The base entrypoint starts as root and drops to paseo itself.
		expect(text).not.toMatch(/^USER /m);
	});

	test("CI publishes it under the same tag", () => {
		const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toContain("sha256sum apps/runner/box/Dockerfile | cut -c1-12");
		expect(ci).toContain("context: apps/runner/box");
		expect(BOX_IMAGE_REPO).toBe("ghcr.io/lagz0ne/mastermind");
	});
});
