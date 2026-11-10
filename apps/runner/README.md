# mastermind-runner

The adapter a user runs on their own machine. It connects to Mastermind over
NATS (WebSocket) as a **service account** of the user's account, takes work from
queues and runs agents for it through Paseo. Agents never talk to Mastermind;
the runner reports for them.

Needs: `paseo` with its daemon running, and a provider that is logged in.

## Install (no clone, no bun)

Mastermind serves the runner compiled for linux and darwin (x64, arm64), built from
the same commit as the server. `/people` → **Add runner** shows the one command:

```bash
curl -fsSL <mastermind url>/install.sh | sh \
  && ~/.local/bin/mastermind-runner enroll <mme_token> --url <mastermind url> --queue <q> --workdir . \
  && ~/.local/bin/mastermind-runner start
```

`install.sh` downloads `<url>/download/mastermind-runner?os=&arch=`, checks it against
`<url>/download/mastermind-runner.sha256?os=&arch=`, and installs nothing on a mismatch.
`MASTERMIND_RUNNER_DIR` changes the directory (default `~/.local/bin`). The runner reports
its commit (`mastermind-runner --version`); `/people` marks a runner on another commit
than the server as `old version`: run the install line again. The image build compiles
the targets in `RUNNER_TARGETS` (build arg, default `all`; ~45 MiB gzipped each).

## From source

```bash
# 1. In Mastermind, the account mints an enrol token (POST /api/auth/tokens {kind: "enrol", name}).
# 2. Spend it once; settings given here are saved with the credential (mode 0600).
bun src/cli.ts enroll <mme_token> --url <mastermind url> --queue <q> --workdir <dir> \
  [--provider claude] [--mode bypassPermissions] [--capacity 1] [--capability git]...
# 3. Run.
bun src/cli.ts start          # flags here override the saved settings; --save keeps them
bun src/cli.ts check          # are the declared capabilities real?
bun src/cli.ts status         # config without the secret
```

Config: `$MASTERMIND_RUNNER_CONFIG`, else `$XDG_CONFIG_HOME/mastermind/runner.json`,
else `~/.config/mastermind/runner.json`. `MASTERMIND_URL` and `MASTERMIND_NATS_URL`
override the URLs. There is no default host.

Per dispatch: check `env.requires` (`os:`, `arch:`, `<tool>`, `<tool>>=<version>`,
opaque `ns:x`), the checkout (`--workdir`, or `--repo <url>=<dir>` when the dispatch
names a repo), secrets by name, and `env.setup` (only with `--allow-setup`). A failed
check releases the bead with the reason. Else `paseo run --output-schema` starts the
agent (labels `mastermind.execution`, `mastermind.bead`; never two agents for one
execution), the runner heartbeats the lease, and the agent's own answer decides:
`done` completes the bead with its summary, `failed` releases it with the reason.
A lost lease stops the agent. Stop (Ctrl-C) stops agents and releases their beads.

Exit codes: 0 stopped, 1 error, 2 usage, 3 revoked (the credential was refused;
the config is marked `revoked`, enroll again).

Tests: `bun test`. The NATS test needs `NATS_SERVER=/path/to/nats-server`.
