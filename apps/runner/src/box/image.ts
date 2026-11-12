/**
 * The runner's default box image: apps/runner/box/Dockerfile (Paseo daemon +
 * Claude Code + bun). CI publishes it in the app's public package, tagged
 * `box-<first 12 hex of the sha256 of the Dockerfile>`, and builds it only
 * when that tag is missing. The test fails with the new hash when the
 * Dockerfile changes, so the runner always names an image of its own commit.
 */

/** The public package of the app image; box images are its `box-*` tags. */
export const BOX_IMAGE_REPO = "ghcr.io/lagz0ne/mastermind";

/** First 12 hex of the sha256 of apps/runner/box/Dockerfile. */
export const BOX_IMAGE_HASH = "69929cd3aaf7";

/** Image for an environment with no image, when the runner names none either. */
export const DEFAULT_BOX_IMAGE = `${BOX_IMAGE_REPO}:box-${BOX_IMAGE_HASH}`;

/** The tag hash of a Dockerfile text (what CI computes with sha256sum). */
export function boxImageHash(dockerfile: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256")
		.update(dockerfile)
		.digest("hex")
		.slice(0, 12);
}

/**
 * Paseo daemon settings for a box, in any image: no speech (else the daemon
 * downloads a local speech model, about 630 MB, at start) and no web UI.
 */
export const QUIET_PASEO_ENV: Record<string, string> = {
	PASEO_DICTATION_ENABLED: "false",
	PASEO_VOICE_MODE_ENABLED: "false",
	PASEO_WEB_UI_ENABLED: "false",
};
