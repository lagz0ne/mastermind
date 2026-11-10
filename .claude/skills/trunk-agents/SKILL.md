---
name: trunk-agents
description: How to work in this repo alongside other agents sharing the SAME working directory, using trunk-based development (commit straight to main, no branches/worktrees/PRs) with beads (bd) as the shared source of truth. Use at session start, before editing files, before any git command, when committing/pushing/shipping, when CI is red, or when unsure what other agents are doing.
---

# Trunk-based, multi-agent, one working directory

**Model:** commit straight to trunk. There are no feature branches, no PRs and no worktrees.
Several agents edit the same checkout at the same time, so git cannot tell you who is
doing what. Use **beads** to see what other agents are doing:

| Question | Answer via |
|---|---|
| What's being worked on and by whom? | `bd list --status in_progress` (assignee = agent) |
| What can I pick up? | `bd ready` |
| Who's integrating right now? | `bd merge-slot check` |
| Is trunk broken? | `bd list -p 0 --status open,in_progress` + `gh run list -b main -L 3` |

Quality gates: `scripts/ship.sh` verifies **exactly your commit** before it lands
(pre-integration). CI re-verifies every push to main. CD publishes and deploys every green commit.

## 0. Identity: do this once per session

Pick a unique actor name and **prefix every `bd` and ship command** with it (shell
env does not persist between tool calls):

```bash
BEADS_ACTOR=claude-<short-task>-<4 random chars>   # e.g. claude-auth-k3f9
```

## 1. Orient (session start, and before every new task)

```bash
git pull --rebase --autostash -q origin main   # only if no one holds the merge slot
bd list --status in_progress                   # what others are doing
bd ready                                       # unblocked work
git status --short                             # dirty files are probably OTHER agents' WIP
```

Files that are dirty in `git status` and not covered by your claimed issue **belong to
someone else**. Do not edit, format, revert, stash, or commit them.

## 2. Claim: one issue, explicit file scope

```bash
BEADS_ACTOR=$me bd update <id> --claim        # atomic; "already claimed" → pick another
# or: BEADS_ACTOR=$me bd ready --claim --json # claim next ready issue
# no issue yet? create it first:
BEADS_ACTOR=$me bd create "Add X" -t feature -p 2 -d "why + acceptance" --json
BEADS_ACTOR=$me bd note <id> "files: packages/core/src/x.ts, apps/api/src/routes/x.ts"
```

- Before touching a file, check that no other in_progress issue declares it
  (`bd list --status in_progress --json | grep <path>`). If one does, either
  `bd dep add <yours> <theirs>` and pick other work, or `bd comment <theirs> "..."` to coordinate.
- Scope grew? Update the `files:` note **before** editing the new files.
- Long task: `bd heartbeat <id>` every few minutes so your claim isn't reclaimed.
- Found unrelated work? `bd create ... --deps discovered-from:<id>`. Don't do it inline.

## 3. Ship small and often (many times per hour, not per day)

```bash
BEADS_ACTOR=$me scripts/ship.sh -m "feat(core): add x parser" -i <id> -- <your paths...>
```

`ship.sh` takes the merge slot, rebases on origin/main, builds a snapshot of
**HEAD + only your paths**, runs `bun run check` on it, commits only those paths,
pushes, runs `bd dolt push`, and releases the slot. If it fails, nothing was
committed and the failure is in **your** change.

- Conventional commits: `feat|fix|refactor|test|chore|docs(scope): ...`
- Unfinished feature? Still ship it, but keep it unreachable: don't wire it up yet,
  hide it behind a flag/env var, or use branch-by-abstraction. Trunk must always be deployable.
- Format only your files: `bun x biome check --write <paths>`. **Never** `bun run format`.
- New dependency? Include `bun.lock` and the package's `package.json` in your paths.

Then close or continue:

```bash
BEADS_ACTOR=$me bd close <id> -r "shipped <sha>: what changed"
```

## 4. Forbidden in this shared directory

`git checkout -b`, `git switch`, `git worktree`, `git stash`, `git add -A` / `git add .`,
`git commit -a`, `git reset --hard`, `git clean`, `git checkout -- <file>` / `git restore`
on files you don't own, `git push --force`, interactive rebase, and committing outside `ship.sh`.
Each of these destroys or captures another agent's uncommitted work.

## 5. Red trunk = stop the line

If `gh run list -b main -L 3` shows a failure:
1. If it's your commit: fix forward within ~10 min, or revert it
   (`git revert --no-edit <sha>` then ship the touched paths). Reverting is cheap and fine.
2. Otherwise check whether a P0 already exists (`bd list -p 0`). If not, create one:
   `bd create "main red: <job>" -t bug -p 0 -d "<run url>"`. Hold non-fix ships until it's closed.

## 6. Recovery

- Merge slot stuck: `bd merge-slot check`. If the holder has no live in_progress
  work, run `bd merge-slot release --holder <holder>`.
- Dead agent's claims: `bd reclaim`. To hand off: `bd unclaim <id> -r "why"`.
- Ending your session with unshipped work: ship what's green. For the rest, leave a
  `bd note <id> "state: ..., next: ..."`, then either keep the claim (if you'll resume)
  or `bd unclaim`. Never leave orphaned dirty files with no issue explaining them.
