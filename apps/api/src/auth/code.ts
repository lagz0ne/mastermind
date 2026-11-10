/**
 * Login codes: what a browser shows and a human reads aloud to an approver.
 * 8 characters of an alphabet without 0/O and 1/I (32 symbols, 40 bits),
 * shown as `ABCD-EFGH`. Input is case-insensitive and ignores '-' and spaces.
 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export function randomCode(): string {
	// 32 symbols: the low 5 bits of a byte pick one without bias.
	const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
	return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

/** The canonical code (`ABCDEFGH`) of user input, or null when it cannot be one. */
export function normalizeCode(input: string): string | null {
	const code = input.toUpperCase().replace(/[\s-]/g, "");
	if (code.length !== CODE_LENGTH) return null;
	for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
	return code;
}

/** `ABCDEFGH` -> `ABCD-EFGH`. */
export const formatCode = (code: string) =>
	`${code.slice(0, 4)}-${code.slice(4)}`;
