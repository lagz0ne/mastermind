#!/usr/bin/env bash
# ship.sh — verify exactly-what-you-commit, then commit + push to main.
#
# Built for trunk-based development with several agents sharing ONE working dir:
#   * takes the beads merge slot so only one agent integrates at a time
#   * builds a snapshot of HEAD + only YOUR paths (other agents' WIP excluded)
#     and runs the full gate on it ("not rocket science" rule)
#   * commits only your paths, rebases on origin/main, pushes, syncs beads
#
# Usage: scripts/ship.sh -m "feat(core): msg" [-i mm-abc] -- <path>...
set -euo pipefail

die() { echo "ship: $*" >&2; exit 1; }
log() { echo "ship: $*" >&2; }

msg="" issue=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) msg="$2"; shift 2 ;;
    -i) issue="$2"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown arg '$1' (paths go after --)" ;;
  esac
done
paths=("$@")
actor="${BEADS_ACTOR:-${PASEO_AGENT_ID:+paseo-${PASEO_AGENT_ID:0:7}}}"
[[ -n "$actor" ]] || die "set BEADS_ACTOR to your unique agent name"
export BEADS_ACTOR="$actor" PATH="$HOME/.bun/bin:$PATH"
[[ -n "$msg" ]] || die "-m <message> is required"
[[ ${#paths[@]} -gt 0 ]] || die "list the paths you changed after --  (never ship the whole tree)"

repo="$(git rev-parse --show-toplevel)"
cd "$repo"
[[ "$(git symbolic-ref --short HEAD)" == "main" ]] || die "trunk-based: must be on main"
trailer=(); [[ -n "$issue" ]] && trailer=(--trailer "Refs: $issue")

# --- 1. take the merge slot (serializes integration across agents) ---------
wait_max="${SHIP_WAIT_SECONDS:-600}" waited=0
until bd merge-slot acquire --holder "$actor" >/dev/null 2>&1; do
  (( waited >= wait_max )) && die "merge slot still held after ${wait_max}s: $(bd merge-slot check 2>&1 | tr '\n' ' ')
  If the holder is dead: bd merge-slot release --holder <holder>"
  sleep $(( RANDOM % 4 + 2 )); waited=$(( waited + 4 ))
done
tmp="$(mktemp -d)"; idx="$(mktemp)"
cleanup() { bd merge-slot release --holder "$actor" >/dev/null 2>&1 || true; rm -rf "$tmp" "$idx"; }
trap cleanup EXIT
log "holding merge slot as $actor"

# --- 2. catch up with trunk ------------------------------------------------
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git pull --rebase --autostash -q origin main
fi

# --- 3. snapshot = HEAD + your paths only, then run the gate on it ---------
GIT_INDEX_FILE="$idx" git read-tree HEAD
GIT_INDEX_FILE="$idx" git add -A -- "${paths[@]}"
tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
[[ "$tree" != "$(git rev-parse HEAD^{tree})" ]] || die "nothing to ship in: ${paths[*]}"
git archive "$tree" | tar -x -C "$tmp"
log "verifying snapshot $tree"
( cd "$tmp" && bun install --frozen-lockfile >/dev/null && bun run check --cache-dir="$repo/.turbo/cache" ) \
  || die "gate failed on your snapshot — fix before shipping (nothing committed)"

# --- 4. commit only your paths; make sure it is the tree we tested ---------
git add -A -- "${paths[@]}"   # needed so new (untracked) files are known to --only
git commit -q --only -m "$msg" "${trailer[@]}" -- "${paths[@]}" || die "commit failed (see hook output above)"
if [[ "$(git rev-parse HEAD^{tree})" != "$tree" ]]; then
  git reset -q --soft HEAD^ && git reset -q -- "${paths[@]}"
  die "files changed while verifying — re-run ship"
fi

# --- 5. push (one rebase retry if trunk moved), then sync beads ------------
if ! git push -q -u origin main 2>/dev/null; then
  git pull --rebase --autostash -q origin main && git push -q -u origin main \
    || die "push failed — commit $(git rev-parse --short HEAD) is local; resolve and push"
fi
bd dolt push >/dev/null 2>&1 || log "warn: bd dolt push failed (git push succeeded)"
log "shipped $(git rev-parse --short HEAD) → origin/main"
