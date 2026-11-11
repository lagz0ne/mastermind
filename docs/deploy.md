# Deploy

Mastermind is the code. It uses services, and it reaches every one of them through configuration.
The repo owns its deployment: `deploy/dokploy.ts` talks to the Dokploy API, and nothing else on the
machine is needed. The example site is https://mastermind.vibea.dev.

```bash
export DOKPLOY_API_KEY=...            # or DOKPLOY_API_KEY_FILE=<path to a file that holds it>
bun deploy/dokploy.ts status          # what runs, env key names, health
bun deploy/dokploy.ts apply           # create or update NATS and the app env; deploy; verify
bun deploy/dokploy.ts secrets         # redeploy hooks + PUBLIC_URL into the GitHub environment
bun deploy/dokploy.ts login-approve <code> --account <name>   # approve a login code shown on /login
bun deploy/dokploy.ts release <sha>   # deploy the image of one commit (sha-<sha> tag), show queue/status/log
bun deploy/dokploy.ts release latest  # deploy :latest (what the app hook deploys)
bun deploy/dokploy.ts retire [--stop] # list (or stop) the services in site.json "retired"; never deletes
```

`apply` is safe to run again: it keeps existing secrets, changes only what differs, and ends with a
check from outside (health, then the public NATS WebSocket).

## Site config

`deploy/site.json` holds every value of one site: the Dokploy URL, the public URL, the project and
service names, the git source, and extra app env (`appEnv`, never secrets). For another site, write
another file and set `MASTERMIND_SITE=<path>`. No host and no machine path is in the code;
`deploy/src/independence.test.ts` (part of `bun run check`) fails if one comes back.

The Dokploy project and the app (image) must exist before the first `apply`.

## Services

| Service | Defined in | What | Reachable |
|---|---|---|---|
| `mastermind` | CI (`.github/workflows/ci.yml`) | the app image: UI and `/api/*`. Volume `/backups` (JetStream backups) | the public URL, port 3000 |
| `mastermind-nats` | `deploy/nats` (Dokploy application, built from git) | `nats:2.15.2` with `nats.conf` baked in: the bus to runner adapters. Volume `/data/jetstream` | 4222 and 8222 internal only; WebSocket 8080 public as `wss://<public host>/nats` |

NATS is a Dokploy application (not a compose service) because it needs a public route, and a Dokploy
whose Traefik reads only Dokploy's route files gives routes to applications only.

The backend is Bun + NATS only. All state is on NATS JetStream: the work store (stream `MM_WORK`) and
KV (accounts, routing, environments). There is no SQL database.

### Retired services

`deploy/site.json` `"retired"` names the services of the old stores: `mastermind-infra` (a Dokploy
compose with Dolt, the beads work queue) and `mastermind-db` (Postgres). Nothing uses them since
mm-210.35; they held test data only. `bun deploy/dokploy.ts retire` lists them with their status;
`retire --stop` stops them and keeps their volumes. Deleting them is a human's decision, made in
Dokploy. `apply` removes the old app env keys (`DOLT_*`, `DATABASE_URL`, `WORK_STORE`, `BD_*`).

## Secrets

Secrets live only in Dokploy, as service env. `apply` makes the missing ones and never prints a value:
the NATS auth password and issuer seed (env of the app; the NATS server gets the password and the public key derived from the seed). To rotate one,
delete its key in Dokploy and run `apply`.

## CD

Every push to `main`: check → publish the image → deploy. The deploy job calls the Dokploy hook of
NATS only when `deploy/nats` changed since the head commit of the newest earlier CI run whose
redeploy step succeeded (`deploy/src/nats-base.ts`; that run already asked for every NATS change up
to its commit), calls the app hook, then waits until `/api/health` reports this commit with
`ok: true`, and checks the public NATS WebSocket.

The NATS base is NOT the commit the app serves. Until mm-210.38 it was: while the app lagged behind
(pinned image, jammed Dokploy queue), one old `deploy/nats` change counted as new on every run, each
run queued another NATS deployment, and they restarted NATS hours later. When no earlier run is found,
CI leaves NATS alone; redeploy `mastermind-nats` in Dokploy by hand if `deploy/nats` changed.

Dokploy runs one deployment at a time for **all** its projects. An accepted hook can wait minutes
behind other projects' builds, and a `:latest` deployment record does not say which commit it ran.
So the app deploy has two modes:

- **`DOKPLOY_API_KEY` is a secret of the GitHub environment**: CI runs `bun deploy/dokploy.ts release
  <sha>`. It pins the image to `sha-<sha>` (the tag CI published), deploys it, sets the image back to
  `:latest` as soon as Dokploy has started that deployment (so no pin stays behind), prints the Dokploy queue
  while ours waits, fails with the deployment log tail on error, and with the app log when health does
  not reach the commit.
- **No key** (hooks only): CI posts the app hook (`:latest`) once (a second post only adds a job to
  the shared queue), and fails after 15 minutes. It cannot see the queue or the log.

`GET /api/health` reports `version` (the commit) and one probe per dependency: `nats` (the
dispatcher) and `work` (the work store). Each is `up`, `down` or `unconfigured`; any `down` makes it a
503. `jetstream` (storage use and the last backup) is a warning only.

## When NATS restarts

NATS restarts on every `mastermind-nats` deployment. The api must not need a hand after that
(incident mm-210.38: 11.5 h down, because the api's connections closed for good and the process lived on).

- **Reconnect forever.** The api has three NATS connections, all opened by `startAuth`
  (`apps/api/src/auth/start.ts`): `mastermind-auth` (the auth callout), `mastermind` (APP: the work
  store, dispatcher, KV, backups) and `mastermind-sys`. Each reconnects without limit, every 2 s plus
  up to 1 s of jitter, with a 5 s limit per dial. Subscriptions, consumers and KV watches come back
  with the connection.
- **Auth errors are retried.** `mastermind` and `mastermind-sys` log in through the api's own auth
  callout, which needs a moment after a NATS restart. The server answers `Authorization Violation`
  meanwhile, and nats.js closes a connection after two of them unless told otherwise
  (`retryAuthErrors` in `@mastermind/bus` connect). That was the cause of mm-210.38.
- **A closed connection exits the process.** If a connection still closes (not by shutdown), the api
  logs one line `nats: connection <name> closed (...); exiting with 1 ...` and exits 1. The
  orchestrator starts a new one.
- **Container healthcheck.** The image checks `/api/health` every 15 s. Four failures in a row (about
  60 s of `ok: false`, that is `nats` or `work` down) make the container unhealthy, and swarm replaces
  it. The first 90 s after a start do not count.
- The app log shows `nats: <connection> disconnect` and `nats: <connection> reconnect`.

Test: `NATS_SERVER=<nats-server binary> bun test src/nats-restart` in `apps/api` runs the real api
against a real `nats-server` with `deploy/nats/nats.conf`, stops NATS for 60 s, and also brings it
back while the callout cannot serve. Health, login start, the board and the dispatcher must be back
within 15 s.

### Alert: health not ok for 2 minutes

Every `/api/health` answer (the container healthcheck asks every 15 s) adds 1 to the counter
`mastermind.health.checks` with the attribute `ok` (`true` or `false`), exported as OTLP (service
`mastermind`). In the Victoria stack, metric names stay dotted. Alert (vmalert / MetricsQL) when, for
2 minutes, there were `ok=false` answers and no `ok=true` answer, or when the api sends nothing:

```yaml
- alert: MastermindHealthNotOk
  expr: |
    sum(increase({__name__="mastermind.health.checks", service.name="mastermind", ok="false"}[2m])) > 0
    unless
    sum(increase({__name__="mastermind.health.checks", service.name="mastermind", ok="true"}[2m])) > 0
  annotations:
    summary: "Mastermind /api/health ok=false for 2 minutes (nats or work down)"
- alert: MastermindHealthSilent
  expr: absent_over_time({__name__="mastermind.health.checks", service.name="mastermind"}[5m])
  annotations:
    summary: "Mastermind sends no health metric for 5 minutes (api down or telemetry off)"
```

The alert rules live with the Victoria stack, not in this repo. An outside probe of
`<public URL>/api/health` (status 503 = not ok) is a good second signal.

## Work store

The work store is JetStream (`packages/work`), on the dispatcher's NATS (auth's APP connection, or
`DISPATCH_NATS_URL` in local dev). Without NATS, work is off and `/api/board`, `/api/beads` answer 503.

One stream `MM_WORK` (subjects `mm.work.<id>`, file storage, 1 replica, no age limit,
`max_bytes` 1 GiB with discard `new`) holds every item and its history: one message per change. A write
is a compare-and-set on the item's subject, so a claim race has one winner. Lease renewals go to the KV
bucket `mm_work_leases`, not to the stream. Each replica keeps the board in memory, loaded from the last
message of each item and kept live by an ordered consumer. A full stream refuses writes; it never drops
items. Not available yet: dependencies (`blocked` is always false).

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

## JetStream: durability, backup, restore

All of Mastermind's state is in JetStream, in NATS account `APP`: work items and their history
(stream `MM_WORK`) and the KV buckets (accounts, sessions, routing, environments, leases). There is
one NATS server.

### Durability

- The store is `/data/jetstream` on the Docker volume `mastermind-nats-data` (`apply` mounts it). A
  redeploy or a restart of `mastermind-nats` keeps it.
- `sync_interval: always`: every write is on disk before NATS acknowledges it. The default (fsync
  every 2 min) loses up to 2 min of acknowledged writes on an OS crash or power loss.
- Proof in production: write a probe marker, redeploy NATS, read it, remove it:

  ```bash
  bun deploy/dokploy.ts jetstream marker write    # KV mm_probe_marker + stream MM_PROBE_MARKER
  # redeploy mastermind-nats (CI does it when deploy/nats changes)
  bun deploy/dokploy.ts jetstream marker check    # exit 1 when the marker is gone
  bun deploy/dokploy.ts jetstream marker remove
  ```

### Limits

| What | Limit | Set in |
|---|---|---|
| server, file store | 20 GB | `deploy/nats/nats.conf` `max_file_store` |
| server, memory store | 512 MB | `max_memory_store` |
| account `APP`, file | 10 GB | `accounts.APP.jetstream.max_file` |
| account `APP`, memory | 256 MB | `accounts.APP.jetstream.max_mem` |
| `MM_WORK` (items and history) | 1 GiB, discard `new`, no age limit | `packages/work` (`maxBytes`) |
| lease and token buckets | per-key TTL | the code that opens them |

`MM_WORK` has no age limit, because an item is the last message of its subject: an age or a
discard-`old` limit would delete live items. When it is full, writes fail and nothing is lost.

`GET /api/health` has a `jetstream` field: `storage` (`used`, `limit`, `percent` of the `APP` limit,
`warn: true` above 80 percent) and `backup` (`last` backup id, `error`). It is a warning: it never
makes health a 503.

### Backup

The api backs up every stream of `APP` on a timer, with the JetStream snapshot API (the same as
`nats stream backup`; durable consumers included). It runs in the api because `APP` is reachable
only through the api's auth callout, and the api already holds that connection: a separate job would
need its own credential and its own scheduler.

| Var | Example | Notes |
|---|---|---|
| `BACKUP_URL` | `file:///backups/nats` or `s3://bucket/prefix` | unset: no backups. `apply` sets `file:///backups/nats` when it is missing |
| `BACKUP_INTERVAL_MINUTES` | `360` | default 6h; the first backup runs 1 min after start |
| `BACKUP_KEEP` | `28` | complete backups to keep (default 28: 7 days at 6h) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` | | for `s3://` only (Bun's S3 client; the `AWS_*` names work too). Secrets: Dokploy only |

One backup is a directory `<BACKUP_URL>/<UTC time>/` with `<stream>.snap` per stream and
`manifest.json` (config, state, size and sha256 of each file). The manifest is written last: a
directory without it is incomplete; it is never restored and is pruned. The log line is
`backup: <id>: <n> streams, <bytes> bytes to <url> in <ms>ms`.

`file:///backups/nats` is a volume of the app on the same machine as NATS. It protects against a bad
write or a lost NATS volume, not against the loss of the machine. For an off-machine copy, set
`BACKUP_URL` to an S3-compatible bucket, or pull one from another machine:

```bash
bun deploy/dokploy.ts jetstream backup --url file:///some/dir/on/this/machine
```

`deploy/dokploy.ts jetstream <command>` runs the backup CLI (`apps/api/src/backup/cli.ts`) from a
clone against the public NATS WebSocket, logged in as the api (the internal token derived from
`NATS_ISSUER_SEED`, read through the Dokploy API and never printed). In the app container the same CLI
is `bun backup.js <command>` and uses the app env.

### Restore

Restore puts the streams of one backup into a NATS. It checks the sha256 of every file before it
changes anything. A stream that exists is replaced only when it is empty (the api makes empty buckets
when it starts on an empty NATS); one with data needs `--force`.

1. **Drill it locally** (an empty NATS, no production):

   ```bash
   NATS_SERVER=/path/to/nats-server bun test apps/api/src/backup
   # includes: marker + backup on one server, then 'restore latest' into an empty one, same data
   ```

   By hand, against two local servers without auth:

   ```bash
   export BACKUP_URL=file:///tmp/mm-drill
   NATS_WS_URL=ws://127.0.0.1:<ws port of A> bun apps/api/src/backup/cli.ts backup
   NATS_WS_URL=ws://127.0.0.1:<ws port of B> bun apps/api/src/backup/cli.ts restore latest
   ```

2. **Production** (the NATS volume is lost or holds bad data). The api must run: its auth callout
   admits the CLI. In the app container (Dokploy: `mastermind` → terminal):

   ```bash
   bun backup.js list                      # complete backups, oldest first
   bun backup.js backup                    # first, if the current data may still be useful
   bun backup.js restore <id|latest>       # into an empty NATS (the api's empty buckets are replaced)
   bun backup.js restore <id> --force      # replaces streams that have data: the current data is gone
   ```

   Then redeploy the app (Dokploy: `mastermind` → deploy): it holds the board, routing and sessions
   in memory. `GET /api/health` shows `work: up`, and the board shows the items of the backup.

What you lose: writes after the backup, up to `BACKUP_INTERVAL_MINUTES`. Sessions in the backup are
valid again; sessions made later are gone (people log in again). Clients that follow the journal by
sequence must reset their cursor when the restored stream is behind.

### What one NATS server does not protect against

- **Loss of the machine or its disk**: the NATS volume and `file://` backups are on the same disk.
  Only an off-machine `BACKUP_URL` (S3) or a pulled copy helps, and you lose the writes since it.
- **Downtime**: while NATS redeploys or restarts (seconds), writes fail and runners reconnect.
- **Store corruption** by a NATS bug or a full disk: restore the last backup.
- **A bad write by the app** (a bug that deletes items): restore, and lose the writes since.

**A 3-node cluster** (not built). Streams with 3 replicas survive the loss of one node, without
downtime and without data loss. Here it costs: three NATS services with `cluster` routes and TLS
between them, three times the disk, and writes that wait for 2 of 3 nodes. On this ONE machine it
protects only against one NATS process or one volume failing, not against the loss of the machine;
for that it needs three machines (three small VMs, routes over a private network, Dokploy in swarm
mode or NATS outside Dokploy). At Mastermind's size an S3 `BACKUP_URL` gives most of the protection
for little cost.
