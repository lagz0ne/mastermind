import { describe, expect, test } from "bun:test";
import { buttonVariants } from "./button.tsx";

// mm-210.40: compact controls (28px), 32px touch targets on a phone.
describe("button sizes", () => {
	test("default and sm are 28px, 32px below sm", () => {
		for (const size of ["default", "sm"] as const) {
			const c = buttonVariants({ size });
			expect(c).toContain("h-7");
			expect(c).toContain("max-sm:h-8");
		}
	});

	test("tiny rounded, not a pill", () => {
		expect(buttonVariants()).toContain("rounded-md");
		expect(buttonVariants()).not.toContain("rounded-full");
	});
});
