# NATS for Mastermind

Mastermind and every runner adapter talk over NATS (bead mm-210.15, decisions in epic mm-210).
The hub at `~/work` runs it in Dokploy. This directory holds the config and the checks.

```
adapter ──wss://mastermind.vibea.dev/nats──▶ Cloudflare ─▶ Traefik ─▶ nats:8080 (websocket, no TLS)
mastermind app ──nats://<nats host>:4222 (internal network)──▶ nats:4222
                                                        nats:8222 monitoring (internal only)
```

## Service

| Item | Value |
|---|---|
| Image | `nats:2.15.2` |
| Command | `-c /etc/nats/nats.conf` |
| Config | `deploy/nats/nats.conf` mounted at `/etc/nats/nats.conf` |
| Volume | persistent, mounted at `/data/jetstream` |
| 4222 | client port, internal Docker network only |
| 8080 | WebSocket, public only as `wss://mastermind.vibea.dev/nats` |
| 8222 | monitoring, internal only |

NATS serves the WebSocket on every path, so the Traefik path route does not need to strip `/nats`.

## Env

NATS service: `NATS_AUTH_PASSWORD`, `NATS_ISSUER_PUBLIC` (public nkey of the issuer account key).

Mastermind app: `NATS_URL`, `NATS_AUTH_USER` (`mastermind`), `NATS_AUTH_PASSWORD`,
`NATS_ISSUER_SEED` (seed of the same key), `NATS_PUBLIC_WS_URL`.

The hub makes the secrets. They are never in this repo.

## Auth: the safe state

All clients log in through the NATS auth callout. Only the `mastermind` user in account AUTH
logs in with a password; that is the auth callout service. Mastermind answers
`$SYS.REQ.USER.AUTH` and issues user JWTs for account APP (bead mm-210.12).

Until Mastermind runs the auth callout service, the server refuses **every** other client
connection with `Authorization Violation`. This is correct. It is not an outage.

## Checks

```bash
# config in a real server (needs a nats-server 2.15 binary)
NATS_SERVER=/path/to/nats-server bun test deploy/nats

# public endpoint, from outside the machine
bun deploy/nats/smoke.ts wss://mastermind.vibea.dev/nats
# OK: INFO received, unauthenticated connect refused
```
