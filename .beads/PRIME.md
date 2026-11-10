# Beads: trunk-based, shared working dir

Several agents share this checkout and commit straight to `main`. Follow the `trunk-agents`
skill (`.claude/skills/trunk-agents/SKILL.md`). In short:

- Pick a unique `BEADS_ACTOR` and prefix every `bd` and `scripts/ship.sh` call with it.
- Use `-q` (errors only) or `--json` on bd calls to keep output small.
- Orient: `bd -q list --status in_progress`, `bd ready`, `git status --short` (dirty files you didn't claim belong to others).
- Claim: `bd update <id> --claim`, then `bd note <id> "files: ..."`. Ship: `scripts/ship.sh -m "<msg>" -i <id> -- <paths>`. Close: `bd close <id> -r "..."`.
- Never: branches, worktrees, `git stash`, `git add -A`, `git commit` outside ship.sh, force-push.
- Track work in beads, not TODO lists.
