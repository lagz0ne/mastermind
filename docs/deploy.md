# Deploy

Production is https://mastermind.vibea.dev, on Dokploy (project `mastermind`), owned by the machine hub
at `~/work`. Do not drive Dokploy from this repo: ask the hub (`hubq send "..." --from mastermind`).

| Service | What | Reachable |
|---|---|---|
| `mastermind` | the app image `ghcr.io/lagz0ne/mastermind:latest`: UI, `/api/*`, and `bd serve` as a child | https://mastermind.vibea.dev, port 3000 |
| `mastermind-db` | Postgres 16: Mastermind's own state (`DATABASE_URL`) | internal only |
| `mastermind-dolt` | `dolthub/dolt-sql-server:2.7.2`: the work (beads). Volumes: data `/var/lib/dolt`, backups `/backups` | internal only, port 3306 |
| `nats` | `nats:2.15.2`: the bus between Mastermind and runner adapters. JetStream volume `/data/jetstream` | client 4222 and monitoring 8222 internal only; WebSocket 8080 public as `wss://mastermind.vibea.dev/nats` |

`GET /api/health` reports `version` (the commit) and one probe per dependency: `db`, `dolt`, `bd`.
Each is `up`, `down` or `unconfigured`; any `down` makes it a 503.

## Beads: Dolt + bd serve

Mastermind reads beads straight from Dolt with `Bun.SQL` (MySQL protocol) and writes through `bd serve`,
so claims, leases and the events journal stay correct. The api (`apps/api/src/index.ts`) does this at
boot when `DOLT_URL` is set:

1. If the database has no beads schema (no `issues` table), it runs `bd init --server --external` once
   in a scratch dir. That creates the database. First boot takes about 15s.
2. It writes a disposable workspace (`$BD_WORKSPACE`, default `$TMPDIR/mastermind-beads`): a
   `git init`ed dir (bd resolves workspaces from a git root) with `.beads/metadata.json` (server mode,
   the database name) and `.beads/config.yaml` (`events-journal: true`). All state is in Dolt, so the
   workspace is rewritten on every boot.
3. It runs `bd serve --addr 127.0.0.1:$BD_SERVE_PORT` and restarts it whenever it exits (backoff 0.5s
   doubling to 30s). It listens on loopback only, so it needs no token. The Dolt password reaches bd
   through `BEADS_DOLT_PASSWORD` in its env, never argv.
4. If Dolt is unreachable it retries with backoff instead of crashing; health shows `dolt`/`bd` down
   meanwhile.

The image carries the `bd` binary (version and sha256 pinned in `apps/api/Dockerfile`), `git` (needed by
`bd init` and `bd serve`) and `DO_NOT_TRACK=1` (bd usage metrics off). To upgrade bd, bump `BD_VERSION`
and both checksums from the release's `checksums.txt`.

### Env

| Var | Example | Notes |
|---|---|---|
| `DOLT_URL` | `mysql://root:<pw>@<mastermind-dolt host>:3306/mastermind` | unset: beads off, health says `unconfigured`. Secret: lives in `~/.config/secrets/mastermind-app.env` (hub) |
| `DOLT_BACKUP_URL` | `file:///backups/mastermind` | a path on the **Dolt** container. Unset: no backups |
| `DOLT_BACKUP_INTERVAL_MINUTES` | `360` | default 6h; one sync also runs at boot |
| `BD_SERVE_PORT` | `3010` | loopback port of `bd serve` |
| `BD_PREFIX` | `mm` | issue id prefix, used only when bootstrapping |
| `BD_WORKSPACE` | `/tmp/mastermind-beads` | disposable workspace root |
| `BD_BIN` | `/usr/local/bin/bd` | set in the image |

The Dolt user needs `ALL` on `*.*`: it creates the database on first boot and calls `dolt_backup`.

## Backup

The api registers a Dolt backup named `mastermind-backup` at `DOLT_BACKUP_URL`
(`CALL dolt_backup('add', ...)`) and runs `CALL dolt_backup('sync', 'mastermind-backup')` at boot and
every `DOLT_BACKUP_INTERVAL_MINUTES`. A sync copies the whole database, history included, and logs
`dolt: backup synced to ... in <ms>`. `bd backup` is not used: bd refuses it against a Dolt server it
does not manage. The backup lands on the `/backups` volume of `mastermind-dolt`. Whether that volume
also goes off-machine is the hub's call; check with it.

## Restore

Run these on `mastermind-dolt` (ask the hub: `dolt sql` inside the container, or any MySQL client on the
project network as the root user). They were drilled on dolt 2.7.2 with bd 1.3.4 (mm-210.6).

1. **Check the backup** without touching the live database. Restore a copy next to it, count, then drop it:

   ```sql
   CALL dolt_backup('restore', 'file:///backups/mastermind', 'mastermind_check');
   SELECT count(*) FROM mastermind_check.issues;
   SELECT max(seq) FROM mastermind_check.bd_events_journal;
   DROP DATABASE mastermind_check;
   ```

2. **Replace the live database.** Stop the app first (Dokploy: stop `mastermind`) so nothing writes
   during the swap, then do one of:

   ```sql
   -- the live database still exists: overwrite it in place
   CALL dolt_backup('restore', '--force', 'file:///backups/mastermind', 'mastermind');
   -- the live database is gone
   CALL dolt_backup('restore', 'file:///backups/mastermind', 'mastermind');
   ```

3. Start the app. Within seconds `GET /api/health` shows `"dolt":"up","bd":"up"`, and the next backup sync
   re-registers the backup if the restore dropped it. The app also comes back by itself if the database
   was swapped under it while it ran; stopping it just keeps writes from landing in the old copy.

What you lose: writes after the last sync, up to `DOLT_BACKUP_INTERVAL_MINUTES`. Event journal `seq`
numbers go back to the backup's, so clients that tail `/v0/beads/events?since=<seq>` must reset their
cursor after a restore.

## NATS

Mastermind and every runner adapter talk over NATS: request/reply, subscriptions and JetStream KV.
Adapters connect from outside over WebSocket; the app connects inside the project network. The config
is `deploy/nats/nats.conf`, mounted at `/etc/nats/nats.conf`. Details and checks: `deploy/nats/README.md`.

```
adapter ──wss://mastermind.vibea.dev/nats──▶ Cloudflare ─▶ Traefik ─▶ nats:8080 (no TLS inside)
mastermind app ──NATS_URL (nats://…:4222, internal)──▶ nats:4222
```

Accounts: `AUTH` (one user, `mastermind`: the auth callout service), `APP` (JetStream on; every admitted
client), `SYS`. Every other login goes through the NATS auth callout: Mastermind answers
`$SYS.REQ.USER.AUTH` and issues a user JWT for `APP`, signed with `NATS_ISSUER_SEED` (mm-210.12).

**Safe state.** Until Mastermind runs the auth callout service, NATS refuses every client connection
except the `mastermind` user, with `Authorization Violation`. This is correct. It is not an outage.

### Env

| Var | On | Notes |
|---|---|---|
| `NATS_AUTH_PASSWORD` | nats, app | password of the `mastermind` user. Secret, made by the hub |
| `NATS_ISSUER_PUBLIC` | nats | public nkey (`A…`) of the issuer account key |
| `NATS_ISSUER_SEED` | app | seed (`SA…`) of the same key. Secret, made by the hub |
| `NATS_URL` | app | `nats://<nats host>:4222` |
| `NATS_AUTH_USER` | app | `mastermind` |
| `NATS_PUBLIC_WS_URL` | app | `wss://mastermind.vibea.dev/nats`; given to adapters |

### Check

```bash
NATS_SERVER=/path/to/nats-server bun test deploy/nats          # the config in a real 2.15 server
bun deploy/nats/smoke.ts wss://mastermind.vibea.dev/nats       # public endpoint, from outside
# OK: INFO received, unauthenticated connect refused
```
