# Beads: trunk-based, shared working dir

Several agents share this checkout and commit straight to `main`. Follow the `trunk-agents`
skill (`.claude/skills/trunk-agents/SKILL.md`). In short:

- `BEADS_ACTOR` is preset to `paseo-<agent id>` by a session hook (`echo $BEADS_ACTOR`); if empty, set it yourself on every call.
- Use `-q` (errors only) or `--json` on bd calls to keep output small.
- Orient: `scripts/status.sh` (dirty files you didn't claim belong to others). Delegate: `scripts/spawn.sh <bead>`. Talk: `paseo send <id>`.
- Claim: `bd update <id> --claim`, then `bd note <id> "files: ..."`. Ship: `scripts/ship.sh -m "<msg>" -i <id> -- <paths>`. Close: `bd close <id> -r "..."`.
- Never: branches, worktrees, `git stash`, `git add -A`, `git commit` outside ship.sh, force-push.
- Track work in beads, not TODO lists.
