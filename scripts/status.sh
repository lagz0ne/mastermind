#!/usr/bin/env bash
# status.sh — one-screen picture of the shared trunk: who is doing what, right now.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
me="${BEADS_ACTOR:-${PASEO_AGENT_ID:+paseo-${PASEO_AGENT_ID:0:7}}}"
h() { printf '\n== %s\n' "$*"; }

echo "you: ${me:-<no BEADS_ACTOR set>}   trunk: $(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-60)"

h "in progress (assignee = agent; paseo-<id> → paseo send <id> \"...\")"
bd -q list --status in_progress --json 2>/dev/null | node -e '
  const a = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
  if (!a.length) console.log("  (nothing claimed)");
  for (const i of a) {
    const files = (i.notes || "").split("\n").filter((l) => l.startsWith("files:")).pop() || "files: <undeclared>";
    console.log(`  ${i.id}  ${i.assignee || "?"}  ${i.title}\n      ${files}`);
  }' 2>/dev/null || echo "  (bd unavailable)"

h "merge slot"
bd merge-slot check 2>&1 | sed 's/^/  /'

h "ready to claim"
bd -q ready --json 2>/dev/null | node -e '
  const a = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]").filter((i) => !i.id.endsWith("merge-slot"));
  if (!a.length) console.log("  (none)");
  for (const i of a.slice(0, 10)) console.log(`  ${i.id}  P${i.priority}  ${i.title}`);' 2>/dev/null

h "uncommitted files (not yours unless your bead declares them)"
git status --short | sed 's/^/  /' | head -20
[[ -z "$(git status --short)" ]] && echo "  (clean)"

if command -v paseo >/dev/null 2>&1; then
  h "paseo agents in this dir"
  paseo ls 2>/dev/null | cut -c1-110 | sed 's/^/  /'
fi

if command -v gh >/dev/null 2>&1; then
  h "ci on main (red = stop the line)"
  gh run list -b main -L 3 --json headSha,status,conclusion,displayTitle \
    -q '.[] | "  \(.headSha[0:7])  \(if .status == "completed" then .conclusion else .status end)  \(.displayTitle[0:60])"' 2>/dev/null
fi
