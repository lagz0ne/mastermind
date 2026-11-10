# mastermind

Bun + Turborepo monorepo, trunk-based (everything lands on `main`, every green commit deploys to https://mastermind.vibea.dev).

```bash
bun install
bun run check      # lint + typecheck + test + build (same as CI)
bun run dev
```

- `apps/api`: Bun server, serves the UI and `/api/*` (→ `ghcr.io/lagz0ne/mastermind`)
- `apps/web`: React UI, bundled into `apps/api`
- `packages/*`: shared libraries (`@mastermind/*`)
- Work is tracked in beads: `bd ready`. Agents: see `CLAUDE.md` and the `trunk-agents` skill.
- Commit/push only via `scripts/ship.sh -m "<msg>" -i <bead> -- <paths>`.

## Working with agents (Paseo)

```bash
scripts/status.sh                        # who is doing what
scripts/spawn.sh "Add /version endpoint" # new bead + a Paseo agent working it in this checkout
paseo ls && paseo logs <id>              # follow along
```
