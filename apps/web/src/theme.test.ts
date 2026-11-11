import { describe, expect, test } from "bun:test";

// mm-210.40: light, tiny-rounded, compact Swiss tokens.
const theme = await Bun.file(new URL("./theme.css", import.meta.url)).text();

function token(name: string): string | undefined {
	const root = theme.slice(theme.indexOf(":root"), theme.indexOf("}"));
	return root.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
}

describe("theme tokens", () => {
	test("light only: no dark media query, color-scheme light", () => {
		expect(theme).not.toMatch(/@media[^{]*prefers-color-scheme/);
		expect(token("background")).toBe("#ffffff");
		expect(theme).toMatch(/:root\s*{\s*color-scheme: light;/);
	});

	test("tiny rounded: 4px", () => {
		expect(token("radius")).toBe("4px");
	});

	test("compact: body 13px, small 11px, header 36px", () => {
		expect(token("type-sm")).toBe("13px");
		expect(token("type-xs")).toBe("11px");
		expect(token("header-height")).toBe("36px");
	});
});
