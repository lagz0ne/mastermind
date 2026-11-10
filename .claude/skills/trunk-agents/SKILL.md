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

## 0. Identity: automatic

A SessionStart hook (`scripts/agent-env.sh`) sets `BEADS_ACTOR=paseo-<your short Paseo agent id>`
and puts bun on PATH for every Bash call. Check once with `echo $BEADS_ACTOR`. If it is empty
(non-Claude provider, hook didn't run), prefix every `bd` and ship command yourself:
`BEADS_ACTOR=paseo-${PASEO_AGENT_ID:0:7}`.

The name is the address: a bead assigned to `paseo-113cf46` is held by the Paseo agent you can
reach with `paseo send 113cf46 "..."`.

Keep bd output small: use `bd -q ...` (errors only) for writes, and `--json` when you parse results.
The bd **git hooks are intentionally uninstalled.** They could block commits for up to 300s
on the shared DB lock, and ship.sh calls bd explicitly anyway. Do not run `bd hooks install`.

## 1. Orient (session start, and before every new task)

```bash
scripts/status.sh    # claims + declared files, merge slot, ready work, dirty files, agents, CI
```

Files that are dirty in `git status` and not covered by your claimed issue **belong to
someone else**. Do not edit, format, revert, stash, or commit them.

## 2. Claim: one issue, explicit file scope

Pick from `scripts/status.sh` ("ready to claim"). Never use `bd ready --claim`: the merge slot is
itself a ready bead and that command would grab it and block every ship.

```bash
bd -q update <id> --claim     # atomic; "already claimed" → pick another
# no issue yet? create it first:
bd create "Add X" -t feature -p 2 -d "why + acceptance" --json
bd note <id> "files: packages/core/src/x.ts, apps/api/src/routes/x.ts"
```

- Before touching a file, check that no other in_progress issue declares it
  (`bd list --status in_progress --json | grep <path>`). If one does, either
  `bd dep add <yours> <theirs>` and pick other work, or `bd comment <theirs> "..."` to coordinate.
- Scope grew? Update the `files:` note **before** editing the new files.
- Long task: `bd heartbeat <id>` every few minutes so your claim isn't reclaimed.
- Found unrelated work? `bd create ... --deps discovered-from:<id>`. Don't do it inline.

## 3. Ship small and often (many times per hour, not per day)

```bash
scripts/ship.sh -m "feat(core): add x parser" -i <id> -- <your paths...>
```

`ship.sh` takes the merge slot, fast-forwards to origin/main (it never stashes or rebases),
builds a snapshot of **HEAD + only your paths**, runs `bun run check` on it, commits only those
paths, pushes, releases the slot and runs `bd dolt push`. If trunk moved while it was checking, it
undoes the commit and re-verifies on the new trunk. If it fails, nothing stays committed and the
failure is in **your** change. Paths are relative to where you run it.

If it says it cannot fast-forward, someone's uncommitted file overlaps a commit that landed from
outside this checkout. Find the owner with `scripts/status.sh` and tell them (`paseo send`); do not
stash or discard their file.

- Conventional commits: `feat|fix|refactor|test|chore|docs(scope): ...`
- Unfinished feature? Still ship it, but keep it unreachable: don't wire it up yet,
  hide it behind a flag/env var, or use branch-by-abstraction. Trunk must always be deployable.
- Format only your files: `bun x biome check --write <paths>`. **Never** `bun run format`.
- New dependency? Include `bun.lock` and the package's `package.json` in your paths.

Then close or continue:

```bash
bd close <id> -r "shipped <sha>: what changed"
```

## 4. Forbidden in this shared directory

`git checkout -b`, `git switch`, `git worktree`, `git stash`, `git add -A` / `git add .`,
`git commit -a`, `git reset --hard`, `git clean`, `git checkout -- <file>` / `git restore`
on files you don't own, `git push --force`, `git pull`, `git rebase`, `git revert`, and committing outside `ship.sh`.
Each of these destroys or captures another agent's uncommitted work.

## 5. Red trunk = stop the line

If `gh run list -b main -L 3` shows a failure:
1. If it's your commit: fix forward within ~10 min, or revert it
   (`scripts/ship.sh -r <sha>`: a gated revert of exactly that commit). Never use `git revert`;
   it commits outside the gate. Reverting is cheap and fine.
2. Otherwise check whether a P0 already exists (`bd list -p 0`). If not, create one:
   `bd create "main red: <job>" -t bug -p 0 -d "<run url>"`. Hold non-fix ships until it's closed.

## 6. Paseo: delegate and talk to other agents

All agents run in **local** Paseo workspaces on this one checkout. Never pass
`--new-workspace worktree`, `isolation: "worktree"`, or any branch option.

```bash
scripts/spawn.sh mm-abc                    # put a new agent on an existing bead
scripts/spawn.sh "Add /version endpoint"   # create the bead and put an agent on it
scripts/spawn.sh -p claude/claude-sonnet-5-5 -x "extra instructions" mm-abc
paseo ls                                   # agents in this checkout
paseo logs <id>                            # what an agent is doing
paseo send <id> "..."                      # steer or ask (e.g. the holder of a file you need)
```

- Splitting work: create one bead per independently shippable slice, wire order with
  `bd dep add <later> <earlier>`, give each bead a description with acceptance criteria, then
  spawn one agent per **ready** bead. Slices must not share files; if they must, make them dependent.
- Need a file another agent declared? `paseo send <their id> "need <path> for <bead>, when do you ship?"`
  and work on something else meanwhile. Don't edit it.
- `paseo.json` scripts (`check`, `test`, `status`, `api` service) are available from the Paseo UI
  and `paseo script start <name> --workspace <id>`.

## 7. Recovery

- Merge slot stuck: `bd merge-slot check`. If the holder has no live in_progress
  work, run `bd merge-slot release --holder <holder>` (if the holder is empty: `bd merge-slot release`).
- Dead agent's claims: `bd reclaim`. To hand off: `bd unclaim <id> -r "why"`.
- Ending your session with unshipped work: ship what's green. For the rest, leave a
  `bd note <id> "state: ..., next: ..."`, then either keep the claim (if you'll resume)
  or `bd unclaim`. Never leave orphaned dirty files with no issue explaining them.
