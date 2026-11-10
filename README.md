# mastermind

Bun + Turborepo monorepo, trunk-based (everything lands on `main`, every green commit deploys).

```bash
bun install
bun run check      # lint + typecheck + test + build (same as CI)
bun run dev
```

- `apps/*`: deployables (`apps/api` → `ghcr.io/lagz0ne/mastermind-api`)
- `packages/*`: shared libraries (`@mastermind/*`)
- Work is tracked in beads: `bd ready`. Agents: see `CLAUDE.md` and the `trunk-agents` skill.
- Commit/push only via `scripts/ship.sh -m "<msg>" -i <bead> -- <paths>`.
