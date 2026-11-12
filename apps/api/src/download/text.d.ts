/** Text files bundled with `import x from "./f.md" with { type: "text" }` (Bun). */
declare module "*.md" {
	const text: string;
	export default text;
}
