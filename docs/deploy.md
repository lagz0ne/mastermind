# Deploy

Mastermind is the code. It uses services, and it reaches every one of them through configuration.
The repo owns its deployment: `deploy/dokploy.ts` talks to the Dokploy API, and nothing else on the
machine is needed. The example site is https://mastermind.vibea.dev.

```bash
export DOKPLOY_API_KEY=...            # or DOKPLOY_API_KEY_FILE=<path to a file that holds it>
bun deploy/dokploy.ts status          # what runs, env key names, health
bun deploy/dokploy.ts apply           # create or update Dolt, NATS and the app env; deploy; verify
bun deploy/dokploy.ts secrets         # redeploy hooks + PUBLIC_URL into the GitHub environment
bun deploy/dokploy.ts first-login     # the single-use login URL for the first account (no account yet)
```

`apply` is safe to run again: it keeps existing secrets, changes only what differs, and ends with a
check from outside (health, then the public NATS WebSocket).

## Site config

`deploy/site.json` holds every value of one site: the Dokploy URL, the public URL, the project and
service names, the git source, and extra app env (`appEnv`, never secrets). For another site, write
another file and set `MASTERMIND_SITE=<path>`. No host and no machine path is in the code;
`deploy/src/independence.test.ts` (part of `bun run check`) fails if one comes back.

The Dokploy project and the app (image + Postgres + `DATABASE_URL`) must exist before the first `apply`.

## Services

| Service | Defined in | What | Reachable |
|---|---|---|---|
| `mastermind` | CI (`.github/workflows/ci.yml`) | the app image: UI, `/api/*`, and `bd serve` as a child | the public URL, port 3000 |
| `mastermind-db` | Dokploy database | Postgres 16: Mastermind's own state (`DATABASE_URL`) | internal only |
| `mastermind-infra` | `deploy/compose.yml` (Dokploy compose, built from git) | `dolt`: `dolthub/dolt-sql-server:2.7.2`, the work queue (beads). Volumes: data `/var/lib/dolt`, backups `/backups` | internal only: `mastermind-dolt:3306` |
| `mastermind-nats` | `deploy/nats` (Dokploy application, built from git) | `nats:2.15.2` with `nats.conf` baked in: the bus to runner adapters. Volume `/data/jetstream` | 4222 and 8222 internal only; WebSocket 8080 public as `wss://<public host>/nats` |

NATS is an application and not part of the compose because it needs a public route, and a Dokploy
whose Traefik reads only Dokploy's route files gives routes to applications only.

## Secrets

Secrets live only in Dokploy, as service env. `apply` makes the missing ones and never prints a value:
the Dolt root password (env of `mastermind-infra`), and the NATS auth password and issuer seed (env of
the app; the NATS server gets the password and the public key derived from the seed). To rotate one,
delete its key in Dokploy and run `apply`.

## CD

Every push to `main`: check → publish the image → deploy. The deploy job asks production which commit
is live, calls the Dokploy hook of the infra compose and of NATS only when `deploy/compose.yml` or
`deploy/nats` changed since that commit, calls the app hook, then waits until `/api/health` reports
this commit with `ok: true`, and checks the public NATS WebSocket.

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
| `DOLT_URL` | `mysql://root:<pw>@mastermind-dolt:3306/mastermind` | unset: beads off, health says `unconfigured`. Set by `apply`. A secret (it holds the password) |
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
does not manage. The backup lands on the `/backups` volume of the Dolt container. It is on the same
machine as the data: it protects against a bad write, not against the loss of the machine. An
off-machine copy is not set up yet.

## Restore

Run these on the Dolt server (`dolt sql` inside the `dolt` container of `mastermind-infra`, or any MySQL
client on the Docker network as the root user). They were drilled on dolt 2.7.2 with bd 1.3.4 (mm-210.6).

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

### First start: the first login

While no account exists, EVERY start of the app mints a new single-use login token for the first
account (`admin`) and writes one line to the app log (stdout only, never to the OTLP log exporter):

```
auth: first login (single use): https://<public url>/login#mml_...
```

The URL of the previous start stops working. Each green commit redeploys the app, so do not search
the log by hand. Run this, then open the URL at once:

```bash
bun deploy/dokploy.ts first-login     # reads the app log through the Dokploy API; prints the newest URL
```

When an account exists, no token is minted, the app logs `auth: first login: not needed, ...`, and
the command says so. More people come in by invite from a logged-in account.

**Safe state.** Until Mastermind runs the auth callout service, NATS refuses every client connection
except the `mastermind` user, with `Authorization Violation`. This is correct. It is not an outage.

### Env

| Var | On | Notes |
|---|---|---|
| `NATS_AUTH_PASSWORD` | nats, app | password of the `mastermind` user. Secret, made by `apply` |
| `NATS_ISSUER_PUBLIC` | nats | public nkey (`A…`) of the issuer account key |
| `NATS_ISSUER_SEED` | app | seed (`SA…`) of the same key. Secret, made by `apply` |
| `NATS_URL` | app | `nats://<nats host>:4222` |
| `NATS_WS_URL` | app | `ws://<nats host>:8080`: the internal WebSocket; `@mastermind/bus` connects over WebSocket only |
| `PUBLIC_URL` | app | the public base URL of the site, from `deploy/site.json` |
| `NATS_AUTH_USER` | app | `mastermind` |
| `NATS_PUBLIC_WS_URL` | app | `wss://mastermind.vibea.dev/nats`; given to adapters |
| `AUTH_DISABLED` | app, local dev only | `1`: with auth NOT configured, every `/api` request is account `local`. Ignored when auth is configured. Without auth and without this flag, `/api` routes outside `/api/auth` answer 503. Never set it in Dokploy |

### Check

```bash
NATS_SERVER=/path/to/nats-server bun test deploy/nats          # the config in a real 2.15 server
bun deploy/nats/smoke.ts wss://mastermind.vibea.dev/nats       # public endpoint, from outside
# OK: INFO received, unauthenticated connect refused
```
