# Set up a worker

This page sets up a machine that does work for Mastermind. Do the steps in this order.
You do not need the operator or the lead agent. Every command can run again: it keeps
what is done and continues at the first step that is not done.

Every credential stays on your machine, in the runner's secret store
(`~/.config/mastermind/secrets`, mode 0600). Mastermind never receives a value. It knows
only the secret names that your environments need.

## 1. What you need

| Need | Why | Check |
|---|---|---|
| Linux or macOS | the runner is built for linux and darwin (x64, arm64) | `uname -sm` |
| Docker or Podman | every task runs in a throwaway box | `onboard` finds it (step 3) |
| Paseo, daemon running | the runner starts agents through Paseo | `paseo ls` |
| A Mastermind account | you get the enrol token on `/people` | log in on the Mastermind URL |

No Docker and no Podman? `onboard` stops and prints the install page for your OS and distro
(Docker Engine, Docker Desktop, or Podman). Install it, then run `onboard` again.

## 2. Get an enrol token and install the runner

On `/people`, click **Add runner**. Give the runner a name and a queue. The page shows one
command. The token in it works once and expires after 1 hour.

```bash
curl -fsSL <mastermind url>/install.sh | sh
```

This installs `~/.local/bin/mastermind-runner`. It checks the sha256 of the download first.

## 3. Onboard

```bash
mastermind-runner onboard <mme_token> --url <mastermind url> --queue <q>
```

`onboard` runs these steps. It stops at the first FAIL and prints the fix.

| Step | What it does |
|---|---|
| box engine | Finds Docker or Podman: `DOCKER_HOST`, `/var/run/docker.sock`, rootless Podman (`$XDG_RUNTIME_DIR/podman/podman.sock`), rootful Podman, Docker Desktop, Colima. A socket that is not a default one: it prints the `export DOCKER_HOST=...` line for `start`. Not found: the install link, or `systemctl --user enable --now podman.socket`, or the docker group fix. It also tells you if gVisor (`runsc`) is there (optional, stronger isolation). |
| Paseo and providers | The Paseo daemon answers; each provider is logged in. |
| default box image | Pulls the box image. |
| enroll | Spends the token once. The runner gets its service account. |
| queues | At least one `--queue`. |
| Claude login | The login of the agent in the box. See below. |
| git credential | Clone and push for the box output. See below. |
| secrets | Asks for each secret value that your environments need and that is missing. |
| doctor --deep | Makes a real box, checks it, deletes it, and runs one probe agent. |
| ready | Marks the runner READY. Only now does it get work. |

### Claude login: choose one

| Choice | When | What you do |
|---|---|---|
| `setup-token` | You alone; your own Claude subscription | Run `claude setup-token` in another terminal. Paste the token (`sk-ant-oat...`). Stored as `CLAUDE_CODE_OAUTH_TOKEN`. |
| `api-key` | Shared or team use (recommended there): billed to the organization, one key per runner, you can revoke it alone | Make a key at https://console.anthropic.com/settings/keys. Paste it. `onboard` checks it with Anthropic. Stored as `ANTHROPIC_API_KEY`. |

### Git credential: choose one

| Choice | When | What you do |
|---|---|---|
| `app` (recommended) | A token per task, for one repo, valid 1 hour. Nothing long-lived goes near the agent. | `onboard` opens a page on `http://127.0.0.1:<port>/`. The page sends the app definition to GitHub. On GitHub, click **Create GitHub App**. GitHub sends the browser back; `onboard` stores the app id and key. Then install the app on the repos of your environments (`onboard` opens the link). |
| `token` | Simple; one token for the repos you select | Make a fine-grained token at https://github.com/settings/personal-access-tokens/new: only select repositories; Contents: Read and write; Pull requests: Read and write; Metadata: Read-only. Paste it. Stored as `GITHUB_TOKEN`. |
| `skip` | Public repos only; the box cannot push | Nothing. |

The GitHub App has these permissions only: Contents (write), Pull requests (write),
Metadata (read). It has no webhook. It is private to your account (or to `--github-org <org>`).
The local secrets are `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG`.

Browser on another machine (you are on ssh)? Do one of these:

- Forward the port: `ssh -L <port>:127.0.0.1:<port> <this machine>`, then open the page on your laptop.
- After you click **Create GitHub App**, the browser goes to `http://127.0.0.1:<port>/callback?code=...`.
  That page does not load on your laptop. Copy its address and paste it into `onboard`.

### Scripts (no questions)

```bash
printf '%s' "$ANTHROPIC_API_KEY" | mastermind-runner onboard <mme_token> --url <url> --queue <q> \
  --non-interactive --claude api-key --git app \
  --github-app-id <id> --github-app-key ./app.pem --json
```

A value comes from stdin, never from the command line. `--json` prints the steps as JSON
on stdout (the text lines go to stderr). Make the GitHub App once in a terminal; scripts reuse
its id and key.

## 4. Describe the box of your repo

In your repo:

```bash
mastermind-runner env init . --secret DOCS_KEY --network github.com,registry.npmjs.org --output pr --check-cmd "bun test"
```

Without flags (in a terminal) it asks a few questions. It writes
`.devcontainer/devcontainer.json` with a `customizations.mastermind` block, or merges into the
file that is there. It does not rewrite a file with comments unless you pass `--force`.

```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "customizations": {
    "mastermind": {
      "secrets": ["DOCS_KEY"],
      "network": { "allow": ["github.com", "registry.npmjs.org"] },
      "output": { "kind": "pr" },
      "check": ["bun test"]
    }
  }
}
```

The runner reads `secrets` and `instructions` from the file. The environment in Mastermind
(`/environments`) sets network, output and check. `env test` uses all of them from the file.

Commit and push the file.

## 5. Test the environment

```bash
mastermind-runner env test .          # box steps, no agent
mastermind-runner env test . --deep   # and one probe agent
```

`env test` runs the same steps as a task, without a task: the access check, the
devcontainer build, the box, the clone, the lifecycle commands, the check, the network
phases, and (with `--deep`) a probe agent. It prints PASS or FAIL for each step, with the fix.
It deletes the box. It pushes nothing.

The box clones from `origin` at your current branch (`--ref` for another). It uses
`devcontainer.json` from your disk, so you can test an edit before you commit it. Push your
code changes first: the box does not see them.

## 6. Start

```bash
mastermind-runner start            # or: onboard ... --start
mastermind-runner status           # what the running runner does
mastermind-runner doctor --deep    # test the whole path again
```

## When something fails

| You see | Do this |
|---|---|
| `no box engine on this machine` | Install from the link that `onboard` prints, then run `onboard` again. |
| `Podman is installed but its API socket is off` | `systemctl --user enable --now podman.socket` |
| `... exists but this user may not use it` | `sudo usermod -aG docker $USER`, then log in again. |
| `the GitHub App ... is not installed on any repo` | Open the install link that `onboard` prints. Choose the repos. Run `onboard` again. |
| `GitHub refused the code` | The code works once and for 1 hour. Run `onboard` again. |
| `missing: NAME` (env test) | `mastermind-runner secrets set NAME` |
| `no access` (env test) | Install the GitHub App on the repo, or give the token Contents: read. |

## Prior art

These tools work the same way, and this guide follows them:

- GitHub Actions self-hosted runner `config.sh`: interactive, can run again, `--unattended` for scripts.
- `gh auth login`: a few guided choices, each with a short reason.
- GitHub App Manifest flow: one-click app creation with preset permissions
  (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
- devcontainer CLI `devcontainer up`, and nektos/act: test the environment on your machine before the real run.
