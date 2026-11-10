#!/usr/bin/env bash
# spawn.sh — put a Paseo agent on a bead, in THIS checkout (no worktree, no branch).
#
#   scripts/spawn.sh mm-abc                       # work an existing bead
#   scripts/spawn.sh "Add /version endpoint"      # create the bead, then work it
#   scripts/spawn.sh -p claude/claude-sonnet-5-5 -x "extra instructions" mm-abc
#
# The agent claims the bead, declares its files, ships via scripts/ship.sh and
# closes the bead. Watch with scripts/status.sh or `paseo ls`.
set -euo pipefail
die() { echo "spawn: $*" >&2; exit 1; }

provider="${SPAWN_PROVIDER:-claude/claude-opus-5-5}" mode="${SPAWN_MODE:-auto}" extra=""
while getopts "p:m:x:" o; do
  case "$o" in
    p) provider="$OPTARG" ;;
    m) mode="$OPTARG" ;;
    x) extra="$OPTARG" ;;
    *) die "usage: spawn.sh [-p provider/model] [-m mode] [-x extra] <bead-id | \"title\">" ;;
  esac
done
shift $((OPTIND - 1))
[[ $# -eq 1 ]] || die "give exactly one bead id or a quoted title"
cd "$(git rev-parse --show-toplevel)"

prefix="$(bd -q config get issue_prefix 2>/dev/null || true)"; prefix="${prefix:-mm}"
if [[ "$1" =~ ^${prefix}-[a-z0-9.]+$ ]]; then
  id="$1"
else
  id="$(bd q "$1")" || die "could not create bead"
fi
title="$(bd -q show "$id" --json | node -e 'const a=[].concat(JSON.parse(require("fs").readFileSync(0,"utf8")));process.stdout.write(a[0].title)')" \
  || die "no such bead: $id"

prompt="You are working bead $id (\"$title\") in a checkout SHARED with other agents (trunk-based: no branches, no worktrees).
1. Load the trunk-agents skill and follow it exactly.
2. Run scripts/status.sh, then: bd show $id
3. Claim it: bd -q update $id --claim   (if already claimed by someone else, stop and say so)
4. Declare your files BEFORE editing: bd -q note $id \"files: <paths>\"
5. Implement the smallest change that satisfies the bead, with tests.
6. Ship: scripts/ship.sh -m \"<conventional commit msg>\" -i $id -- <your paths>
7. Confirm CI: gh run watch \$(gh run list -b main -L1 --json databaseId -q '.[0].databaseId') --exit-status
8. Close: bd -q close $id -r \"shipped <sha>: <what changed>\"
If you are blocked, write bd -q note $id \"state: ... next: ...\" and stop. Never touch files outside your declared scope.${extra:+

Additional instructions: $extra}"

args=(run --no-wait -q --cwd "$PWD" --provider "$provider" --title "$id: $title" --label "bead=$id")
[[ -n "$mode" ]] && args+=(--mode "$mode")
agent="$(paseo "${args[@]}" "$prompt")" || die "paseo run failed"
bd -q note "$id" "paseo agent: ${agent:0:7}" || true
echo "spawned ${agent:0:7} on $id — follow: paseo logs ${agent:0:7}  |  steer: paseo send ${agent:0:7} \"...\""
