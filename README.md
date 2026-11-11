# gh-action-service

Clone this repo on any machine, set two env vars, run `bun start` — and it keeps a
**pool of ephemeral GitHub Actions runners** registered to your org, running jobs on
that machine. No Kubernetes, no Docker, no persistent registration tokens to babysit.

It's a small supervisor built with [Effect](https://effect.website) on
[Bun](https://bun.com):

- Uses **just-in-time (JIT) ephemeral runners** — each runner takes exactly one job,
  then removes itself. GitHub's recommended, most secure model.
- Keeps **N runners** alive concurrently; when one finishes a job it's recycled with a
  fresh registration.
- **Deregisters on every exit**, including Ctrl-C, so a runner that dies before taking
  a job doesn't stay behind as an offline name.
- Downloads the official `actions/runner` binary automatically, matched to your OS/arch,
  and rebuilds a slot when that version changes. `latest` keeps updating while the
  process is running.

## How it works

```
                 ┌─ slot 0 ──> generate-jitconfig ──> ./run.sh --jitconfig ──> [one job] ──> exit ──┐
  supervisor ────┼─ slot 1 ──> generate-jitconfig ──> ./run.sh --jitconfig ──> [one job] ──> exit ──┼─> recycle each slot forever
                 └─ slot N ──> …                                                                     ┘
```

Each slot runs in a forever-loop: it calls
`POST /orgs/{org}/actions/runners/generate-jitconfig`, gets a single-use config blob,
launches the runner in its own working directory, and waits. The runner picks up one
job, completes it, and exits — the loop deletes that registration if it is still
present, then registers a fresh one. A 404 on delete means the runner already removed
itself and is treated as success.

The working directory is reused only while it was copied from the release currently
selected. `RUNNER_VERSION=latest` is resolved at startup and about every 15 minutes.
If that lookup fails, the release already in use stays. When GitHub rejects the
running version as deprecated, runners from 2.333.0 on exit 7 and the next pass
resolves `latest` immediately and rebuilds the slot. Unused `.bin-<version>`
downloads are removed.

If `generate-jitconfig` returns 409 because the slot's name is still registered, the
supervisor deletes that org runner only when it is **offline and not busy**, then
retries the create once. An online or busy runner is left alone and the cycle backs off.

## Prerequisites

- [Bun](https://bun.com) (`curl -fsSL https://bun.com/install | bash`)
- A fine-grained Personal Access Token (see below)
- `bash`, `curl`, and `tar` on PATH (standard on Linux/macOS)

## One-time: create the token

1. GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**
2. **Resource owner**: your organization
3. **Organization permissions** → **Self-hosted runners** → **Read and write**
4. Generate, and copy the `github_pat_…` value.

> Org-level runners require org admin to approve fine-grained PAT access to the org the
> first time. If `generate-jitconfig` returns 403, that approval is usually what's missing.

## Quickstart

```bash
git clone <this-repo> gh-action-service && cd gh-action-service
bun install
cp .env.example .env         # then edit GITHUB_TOKEN and GITHUB_ORG

bun run groups               # optional: list runner groups to pick RUNNER_GROUP_ID
bun start                    # downloads the runner on first run, then supervises the pool
```

You should see the runners appear under **Org → Settings → Actions → Runners**. Press
`Ctrl-C` to stop; the pool deregisters itself.

## Configuration

All config is env vars (Bun auto-loads `.env`). Full list in [`.env.example`](./.env.example):

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | ✅ | — | Fine-grained PAT, org "Self-hosted runners: Read and write" |
| `GITHUB_ORG` | ✅ | — | Organization login |
| `RUNNER_COUNT` | | `2` | Number of concurrent runners |
| `RUNNER_LABELS` | | — | Extra labels (comma-separated); `self-hosted`, OS, and architecture are always added |
| `RUNNER_GROUP_ID` | | `1` | Runner group (org default is `1`) |
| `RUNNER_VERSION` | | `latest` | `actions/runner` release, or a pinned version like `2.336.0`. `latest` is re-resolved about every 15 minutes, and immediately after a deprecated exit. A failed lookup keeps the current release. |
| `RUNNER_NAME_PREFIX` | | hostname | Runner name prefix; slot index is appended |
| `RUNNERS_DIR` | | `.runners` | Where the binary + working dirs live (gitignored) |

## On a new machine

That's the whole point — `git clone`, `bun install`, drop in a `.env`, `bun start`.
Give each machine a distinct `RUNNER_NAME_PREFIX` (the hostname default already does
this) so names don't collide across machines.

JIT registrations must explicitly include every routing label. The service derives the
standard labels from the host, such as `self-hosted,Linux,X64` or
`self-hosted,macOS,ARM64`, and then appends `RUNNER_LABELS`. A workflow requesting
`[self-hosted, macOS]` therefore requires this service to be running on a Mac; a runner
name is not a routing label.

## Running it as a long-lived background service

`bun start` runs in the foreground. To keep it running across logouts/reboots:

**Linux (systemd, user service)** — `~/.config/systemd/user/gh-runners.service`:

```ini
[Unit]
Description=GitHub Actions ephemeral runner pool
After=network-online.target

[Service]
WorkingDirectory=%h/gh-action-service
ExecStart=%h/.bun/bin/bun run src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now gh-runners
loginctl enable-linger "$USER"   # keep running when logged out
journalctl --user -u gh-runners -f
```

On macOS, wrap the same `bun run src/main.ts` in a `launchd` plist (or just run it
under `tmux`).

## Notes & limitations

- **Native processes, no isolation.** Jobs run directly on the host with your toolchain.
  Only register runners to repos/workflows you trust — untrusted workflow code would run
  as your user. If you later want per-job isolation, this is the natural place to swap
  `./run.sh` for a container invocation.
- **Rate limits.** Each recycled job costs one `generate-jitconfig` call. A fine-grained
  PAT is fine for personal/low-churn use; a GitHub App is the upgrade path if you hit
  limits or want tighter scoping.
- **The JIT config is passed on the runner's command line**, so it's briefly visible in
  `ps`. It's single-use and expires in ~1 hour.
