# Deploy

Mastermind is the code. It uses services, and it reaches every one of them through configuration.
The repo owns its deployment: `deploy/dokploy.ts` talks to the Dokploy API, and nothing else on the
machine is needed. The example site is https://mastermind.vibea.dev.

```bash
export DOKPLOY_API_KEY=...            # or DOKPLOY_API_KEY_FILE=<path to a file that holds it>
bun deploy/dokploy.ts status          # what runs, env key names, health
bun deploy/dokploy.ts apply           # create or update Dolt, NATS and the app env; deploy; verify
bun deploy/dokploy.ts secrets         # redeploy hooks + PUBLIC_URL into the GitHub environment
bun deploy/dokploy.ts login-approve <code> --account <name>   # approve a login code shown on /login
bun deploy/dokploy.ts release <sha>   # deploy the image of one commit (sha-<sha> tag), show queue/status/log
bun deploy/dokploy.ts release latest  # unpin: back to :latest (what the app hook deploys)
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

Dokploy runs one deployment at a time for **all** its projects. An accepted hook can wait minutes
behind other projects' builds, and a `:latest` deployment record does not say which commit it ran.
So the app deploy has two modes:

- **`DOKPLOY_API_KEY` is a secret of the GitHub environment**: CI runs `bun deploy/dokploy.ts release
  <sha>`. It pins the image to `sha-<sha>` (the tag CI published), deploys it, prints the Dokploy queue
  while ours waits, fails with the deployment log tail on error, and with the app log when health does
  not reach the commit.
- **No key** (hooks only): CI posts the app hook (`:latest`), posts it once more after 5 minutes if the
  commit is not live, and fails after 15 minutes. It cannot see the queue or the log. If someone ran
  `release <sha>` by hand, the hook keeps deploying that pin: run `release latest` to undo it.

`GET /api/health` reports `version` (the commit) and one probe per dependency: `db`, `dolt`, `bd`.
Each is `up`, `down` or `unconfigured`; any `down` makes it a 503.

## Work store: `WORK_STORE`

| `WORK_STORE` | Where work lives |
|---|---|
| `beads` (default) | Dolt + `bd serve`, below. Needs `DOLT_URL`. |
| `nats` | JetStream (`packages/work`), on the dispatcher's NATS (auth's APP connection, or `DISPATCH_NATS_URL`). No `bd serve` child and no Dolt connection: `DOLT_URL` is ignored. Health shows `work: up`. |

With `nats`, one stream `MM_WORK` (subjects `mm.work.<id>`, file storage, 1 replica, no age limit,
`max_bytes` 1 GiB with discard `new`) holds every item and its history: one message per change. A write
is a compare-and-set on the item's subject, so a claim race has one winner. Lease renewals go to the KV
bucket `mm_work_leases`, not to the stream. Each replica keeps the board in memory, loaded from the last
message of each item and kept live by an ordered consumer. A full stream refuses writes; it never drops
items. Not available on this store: dependencies (`blocked` is always false), the `bd` CLI, Dolt history.

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

### Login: a code, approved by the operator or an account

A login is a single-use code. Nothing secret goes to a log or a URL.

1. The person opens `<public url>/login`. The page shows a code (`ABCD-EFGH`, valid 10 min) and
   keeps a cookie that only this browser holds.
2. The person tells the code to an approver:
   - the operator (also for the first account, when no account exists):
     ```bash
     bun deploy/dokploy.ts login-approve ABCD-EFGH --account duke
     ```
     It reads `MASTERMIND_OPERATOR_KEY` from the app env through the Dokploy API (never printed)
     and calls `POST /api/auth/login/approve`. The account is made if it does not exist. The reply
     shows how old the code is and the browser's user agent: refuse a code that you do not expect.
   - a logged-in account, on `/people` → "Approve a login": for itself (another device) or for a
     new account name (an invite).
3. The page polls and logs in within a few seconds. The code works once. Another browser that
   knows the code gets nothing.

`apply` makes `MASTERMIND_OPERATOR_KEY` in the app env when it is missing. Without it, only
accounts approve. Codes are case-insensitive and ignore `-` and spaces.

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
| `MASTERMIND_OPERATOR_KEY` | app | the operator's key to approve login codes. Secret, made by `apply`; read by `login-approve` |
| `NATS_PUBLIC_WS_URL` | app | `wss://mastermind.vibea.dev/nats`; given to adapters |
| `AUTH_DISABLED` | app, local dev only | `1`: with auth NOT configured, every `/api` request is account `local`. Ignored when auth is configured. Without auth and without this flag, `/api` routes outside `/api/auth` answer 503. Never set it in Dokploy |

### Check

```bash
NATS_SERVER=/path/to/nats-server bun test deploy/nats          # the config in a real 2.15 server
bun deploy/nats/smoke.ts wss://mastermind.vibea.dev/nats       # public endpoint, from outside
# OK: INFO received, unauthenticated connect refused
```
