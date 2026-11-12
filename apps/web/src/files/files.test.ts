import { expect, test } from "bun:test";
import { formatBytes, itemFileUrl } from "@mastermind/core";
import { checkFiles } from "./attachments.tsx";

test("files over the limit are refused before the upload", () => {
	const MiB = 1024 * 1024;
	expect(
		checkFiles(
			[
				{ name: "a.zip", size: 48 * MiB },
				{ name: "scan.tiff", size: 780 * MiB },
			],
			512 * MiB,
		),
	).toEqual([
		{ file: { name: "a.zip", size: 48 * MiB } },
		{
			file: { name: "scan.tiff", size: 780 * MiB },
			error: "larger than the limit of 512 MiB",
		},
	]);
});

test("sizes and download links", () => {
	expect(formatBytes(26)).toBe("26 B");
	expect(formatBytes(1536)).toBe("1.5 KiB");
	expect(formatBytes(50 * 1024 * 1024)).toBe("50 MiB");
	expect(itemFileUrl("mm-1.2", { dir: "out", name: "a b.txt" })).toBe(
		"/api/items/mm-1.2/files/out/a%20b.txt",
	);
});
