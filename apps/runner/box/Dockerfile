# The default box image of the Mastermind runner (bead mm-210.56).
# Base: the Paseo daemon image (git, node, gosu). It starts as root and its
# entrypoint drops to the user paseo, so this file does not set USER.
# Added: the provider CLI Claude Code and bun, pinned.
# CI publishes it as ghcr.io/<repo>:box-<first 12 hex of the sha256 of this file>.
# A change here changes the tag: update BOX_IMAGE_HASH in
# apps/runner/src/box/image.ts (its test prints the new value).
FROM ghcr.io/getpaseo/paseo:0.15.4

# The npm cache goes to /tmp: HOME is /home/paseo, and a root-owned cache
# there would break npm for the user paseo.
RUN npm install -g --cache /tmp/npm-cache \
		@anthropic-ai/claude-code@2.1.322 \
		bun@1.4.4 \
	&& rm -rf /tmp/npm-cache \
	&& printf '{"hasCompletedOnboarding":true}\n' > /home/paseo/.claude/.claude.json \
	&& chown paseo:paseo /home/paseo/.claude/.claude.json

# A box never needs speech: without these the daemon downloads a local speech
# model at start (sherpa-onnx, about 1 min of CPU). The CLI must not update itself.
ENV PASEO_DICTATION_ENABLED=false \
	PASEO_VOICE_MODE_ENABLED=false \
	PASEO_WEB_UI_ENABLED=false \
	DISABLE_AUTOUPDATER=1
