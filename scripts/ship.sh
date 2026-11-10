#!/usr/bin/env bash
# ship.sh — verify exactly-what-you-commit, then commit + push to main.
#
# Built for trunk-based development with several agents sharing ONE working dir:
#   * takes the beads merge slot so only one agent integrates at a time
#   * fast-forwards to origin/main (never stashes or rebases anyone's work)
#   * builds a snapshot of HEAD + only YOUR paths (other agents' WIP excluded)
#     and runs the full gate on it ("not rocket science" rule)
#   * commits only your paths and pushes; if trunk moved meanwhile, the commit
#     is rolled back and the whole thing is re-verified on the new trunk
#   * on any failure nothing stays committed
#
# Usage: scripts/ship.sh -m "feat(core): msg" [-i mm-abc] -- <path>...
#        scripts/ship.sh -r <sha> [-m msg] [-i mm-abc]      # revert a commit, gated
set -euo pipefail

die() { echo "ship: $*" >&2; exit 1; }
log() { echo "ship: $*" >&2; }

msg="" issue="" revert=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) msg="$2"; shift 2 ;;
    -i) issue="$2"; shift 2 ;;
    -r) revert="$2"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown arg '$1' (paths go after --)" ;;
  esac
done
actor="${BEADS_ACTOR:-${PASEO_AGENT_ID:+paseo-${PASEO_AGENT_ID:0:7}}}"
[[ -n "$actor" ]] || die "set BEADS_ACTOR to your unique agent name"
export BEADS_ACTOR="$actor" PATH="$HOME/.bun/bin:$PATH"

# Paths are given relative to the caller's cwd; make them repo-root relative.
repo="$(git rev-parse --show-toplevel)"
paths=()
for p in "$@"; do
  abs="$(realpath -m -- "$p")"
  [[ "$abs" == "$repo"/* ]] || die "path is outside the repo (or is the whole repo): $p"
  paths+=("${abs#"$repo"/}")
done
cd "$repo"
[[ "$(git symbolic-ref --short HEAD)" == "main" ]] || die "trunk-based: must be on main"

if [[ -n "$revert" ]]; then
  [[ ${#paths[@]} -eq 0 ]] || die "-r takes no paths (it reverts exactly what <sha> touched)"
  revert="$(git rev-parse --verify -q "$revert^{commit}")" || die "no such commit"
  mapfile -t paths < <(git diff-tree --no-commit-id --name-only -r "$revert")
  [[ -n "$msg" ]] || msg="revert: $(git log -1 --format=%s "$revert") ($(git rev-parse --short "$revert"))"
fi
[[ -n "$msg" ]] || die "-m <message> is required"
[[ ${#paths[@]} -gt 0 ]] || die "list the paths you changed after --  (never ship the whole tree)"
trailer=(); [[ -n "$issue" ]] && trailer=(--trailer "Refs: $issue")

# --- 1. take the merge slot (serializes integration across agents) ---------
slot="$(bd merge-slot check --json 2>&1)" \
  || die "beads merge slot unavailable: ${slot%%$'\n'*}  (fresh clone: bd bootstrap; no slot: bd merge-slot create)"
held=0 tmp="" idx="" reverted=0
cleanup() {
  [[ $reverted -eq 1 ]] && git show --format= --binary "$revert" | git apply --whitespace=nowarn 2>/dev/null
  [[ $held -eq 1 ]] && { bd merge-slot release --holder "$actor" >/dev/null 2>&1 || true; }
  [[ -n "$tmp" ]] && rm -rf "$tmp" "$idx"
  return 0
}
trap cleanup EXIT
holder() { bd merge-slot check --json 2>/dev/null | sed -n 's/.*"holder": *"\(.*\)".*/\1/p'; }
wait_max="${SHIP_WAIT_SECONDS:-600}" SECONDS=0
until bd merge-slot acquire --holder "$actor" >/dev/null 2>&1; do
  [[ "$(holder)" == "$actor" ]] && { log "re-taking my own stale slot"; break; }
  (( SECONDS < wait_max )) || die "merge slot still held by '$(holder)' after ${wait_max}s.
  If that agent is dead: bd merge-slot release --holder '$(holder)'   (empty holder: bd merge-slot release)"
  sleep $(( RANDOM % 4 + 2 ))
done
held=1
tmp="$(mktemp -d)"; idx="$(mktemp)"
log "holding merge slot as $actor"

# Trunk only ever fast-forwards here. No rebase, no autostash: other agents' WIP is untouched.
sync_trunk() {
  git ls-remote --exit-code --heads origin main >/dev/null 2>&1 || return 0  # first push
  git fetch -q origin main
  git merge -q --ff-only origin/main \
    || die "cannot fast-forward to origin/main (see git's message above).
  Uncommitted files overlap what just landed, or local main has unpushed commits. Their owner must reconcile; nothing was changed."
}

if [[ -n "$revert" ]]; then
  git show --format= --binary "$revert" | git apply -R --whitespace=nowarn \
    || die "cannot revert $revert cleanly: someone has uncommitted work in those files"
  reverted=1
fi

for attempt in 1 2 3; do
  # --- 2. catch up with trunk ----------------------------------------------
  sync_trunk

  # --- 3. snapshot = HEAD + your paths only, then run the gate on it -------
  rm -rf "$tmp" && mkdir -p "$tmp"
  GIT_INDEX_FILE="$idx" git read-tree HEAD
  GIT_INDEX_FILE="$idx" git add -A -- "${paths[@]}"
  tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
  [[ "$tree" != "$(git rev-parse HEAD^{tree})" ]] || die "nothing to ship in: ${paths[*]}"
  git archive "$tree" | tar -x -C "$tmp"
  log "verifying snapshot $tree"
  ( cd "$tmp" && bun install --frozen-lockfile >/dev/null && bun run check --cache-dir="$repo/.turbo/cache" ) \
    || die "gate failed on your snapshot — fix before shipping (nothing committed)"

  # --- 4. commit only your paths; make sure it is the tree we tested -------
  git add -A -- "${paths[@]}"   # so new (untracked) files are known to --only
  git commit -q --only -m "$msg" "${trailer[@]}" -- "${paths[@]}" || die "commit failed (see output above)"
  rollback() { git reset -q --soft HEAD^ && git reset -q -- "${paths[@]}"; }
  if [[ "$(git rev-parse HEAD^{tree})" != "$tree" ]]; then
    rollback; die "files changed while verifying — re-run ship (nothing committed)"
  fi

  # --- 5. push; if trunk moved, undo the commit and re-verify on new trunk -
  if err="$(git push -q -u origin main 2>&1)"; then
    reverted=0
    bd merge-slot release --holder "$actor" >/dev/null 2>&1 || true; held=0
    log "shipped $(git rev-parse --short HEAD) → origin/main"
    exit 0
  fi
  rollback
  git fetch -q origin main 2>/dev/null || die "push failed and origin is unreachable (nothing committed): $err"
  [[ "$(git rev-parse origin/main)" != "$(git rev-parse HEAD)" ]] || die "push rejected (nothing committed): $err"
  log "trunk moved while verifying — re-verifying on the new trunk (attempt $attempt/3)"
done
die "trunk kept moving; gave up after 3 attempts (nothing committed)"
