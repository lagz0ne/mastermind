#!/usr/bin/env bash
# SessionStart hook: give every agent session a stable identity + toolchain PATH.
# Claude Code sources $CLAUDE_ENV_FILE before each Bash call, so this persists.
# Identity is paseo-<short agent id> so a bead's assignee can be messaged directly:
#   bd list --status in_progress  →  assignee paseo-2bb477a  →  paseo send 2bb477a "..."
set -euo pipefail
[[ -n "${CLAUDE_ENV_FILE:-}" ]] || exit 0
if [[ -n "${PASEO_AGENT_ID:-}" ]]; then
  actor="paseo-${PASEO_AGENT_ID:0:7}"
else
  actor="claude-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
{
  echo "export BEADS_ACTOR=\"\${BEADS_ACTOR:-$actor}\""
  echo 'export PATH="$HOME/.bun/bin:$PATH"'
} >> "$CLAUDE_ENV_FILE"
