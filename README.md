# OpenClaw + iMessage automation

Local, privacy-safe automation connecting Codex and Claude clients to Apple
Messages through OpenClaw's MCP server and the [`imsg`](https://github.com/openclaw/imsg)
CLI. Repository is public; live handles, paths, messages, configuration, and
backups stay on operator's Mac.

## Architecture

```text
Codex / Claude Code
        │ MCP over stdio
        ▼
OpenClaw 2026.6.5 ── local gateway, loopback only
        │ bundled @openclaw/imessage channel
        ▼
imsg 0.14.1 ── chat.db reads + Messages.app Automation
        │
        ▼
Apple Messages / iMessage
```

OpenClaw owns agent routing and channel lifecycle. `imsg` reads the local Messages
database and sends through Messages.app. No relay service, inbound port, Tailscale
serve/funnel, or cloud message store is introduced by this repository.

## Safety model

- Gateway mode is local, bind is loopback, and Tailscale mode is forced off.
- Direct messages require exact E.164/email allowlist entries.
- Group messages and iMessage-triggered config writes are disabled.
- SIP stays enabled. Integration uses `imsg` basic mode; never run `imsg launch`.
- Dry-run is default for agent MCP registration, activation, and live smoke.
- Mutating activation creates a backup and rolls back on validation/plugin/restart failure.
- Live smoke accepts no custom body, disables SMS fallback, sends at most once,
  never retries an uncertain result, and verifies one exact outgoing row.
- Privacy-safe commands emit fixed statuses/codes, not handles, paths, config,
  account IDs, message fields, or raw diagnostics.

Generated patches under `.local/` are Git-ignored. OpenClaw config, backups, and
Messages data remain sensitive local files. See [SECURITY.md](./SECURITY.md).

## Requirements

- macOS 14 Sonoma or newer.
- Messages.app signed into iMessage. SMS relay is not used by smoke verification.
- Node `22.22.3` or newer compatible release; CI uses `22.22.3` as baseline.
- OpenClaw `2026.6.5`.
- `imsg` `0.14.1`.
- Homebrew, Git, and npm. Xcode Command Line Tools are needed only for source-building `imsg`.

## Install pinned versions

Install supported Node and exact OpenClaw version. Example uses `nvm`; another
version manager or a newer compatible Node release is fine.

```bash
nvm install 22.22.3
nvm use 22.22.3
npm install --global openclaw@2026.6.5
openclaw --version
```

On a first-time OpenClaw installation, create local gateway state without adding
channels yet:

```bash
openclaw onboard \
  --mode local \
  --gateway-bind loopback \
  --tailscale off \
  --install-daemon \
  --skip-channels
```

Complete onboarding by configuring a working model provider, then verify gateway:

```bash
openclaw gateway health --json
```

Never add `--reset` on an existing installation; it can replace established
OpenClaw state and configuration.

Build exact `imsg` release in a stable clone and use its binary in place:

```bash
git clone https://github.com/openclaw/imsg.git imsg-0.14.1
cd imsg-0.14.1
git checkout v0.14.1
make build
export IMSG_CLI_PATH="$(pwd)/bin/imsg"
"$IMSG_CLI_PATH" --version
cd ..
```

Keep clone at that absolute location. Source build places required Swift bundles
beside `bin/imsg`; copying executable alone can break resource loading. Homebrew's
current build is optional only when `imsg --version` reports exact pinned `0.14.1`.

Exact OpenClaw and `imsg` pins are recorded in [`versions.json`](./versions.json).
Node uses compatible engine range from `package.json`; CI exercises baseline
`22.22.3`. Do not use unpinned OpenClaw/`imsg` upgrades without updating pins and
tests.

## Configure macOS permissions

1. Open Messages.app and confirm iMessage is signed in.
2. Keep System Integrity Protection enabled. `csrutil status` must report enabled.
   Basic mode supports text/media send and receive; reactions, edits, unsends,
   effects, typing/read indicators, and group operations remain unavailable.
3. In **System Settings → Privacy & Security → Full Disk Access**, enable the
   parent application that launches this workflow: Terminal, iTerm, Codex, Claude,
   ChatGPT, or another host. Also add exact `IMSG_CLI_PATH` and
   `/usr/local/bin/node` using the file chooser. If Node is installed elsewhere,
   add the exact path returned by `command -v node` too. When ChatGPT/Codex hosts
   commands, add both helper executables:

   ```text
   /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host
   /Applications/ChatGPT.app/Contents/Resources/codex
   ```
4. In **Privacy & Security → Automation**, allow the parent application to control
   Messages. macOS may show this prompt only after the first deliberate smoke send.
5. Restart changed parent applications after granting permissions.

Full Disk Access covers `chat.db` reads. Automation permission covers sends through
Messages.app. Granting one does not grant the other.

## Configure local values

```bash
cp .env.example .env.local
chmod 600 .env.local
```

Edit placeholders, then load values into current shell:

```bash
set -a
source .env.local
set +a
```

Required values:

| Variable | Purpose |
|---|---|
| `PAUL_IMESSAGE_HANDLE` | Exact E.164 number or Apple ID email allowed to DM agent |
| `IMESSAGE_EXTRA_ALLOW_FROM` | Optional comma-separated exact additional handles |
| `IMSG_CLI_PATH` | Absolute path to pinned `imsg` executable |
| `IMESSAGE_DB_PATH` | Absolute path to local Messages `chat.db` |
| `OPENCLAW_CONFIG_PATH` | Absolute path to existing strict-JSON OpenClaw config |
| `IMESSAGE_TEST_RECIPIENT` | Exact smoke-test recipient |
| `IMESSAGE_TEST_ALLOWLIST` | Comma-separated smoke recipients; target must match exactly |
| `IMESSAGE_TEST_CONFIRM` | Exact one-send confirmation; leave unset except deliberate send |

Never commit `.env.local`.

## Runbook

Run commands in this order.

### 1. Preflight local transport

```bash
npm run preflight
```

Checks macOS, Node/OpenClaw/`imsg` pins, SIP, basic mode, bundled iMessage plugin,
and read access to one chat row. `FULL_DISK_ACCESS_REQUIRED` means parent process
still cannot read `chat.db`.

### 2. Configure cross-agent MCP

Preview, then apply missing registrations:

```bash
npm run configure-agents
npm run configure-agents -- --apply
```

Codex registration runs OpenClaw MCP with `--claude-channel-mode off`; Claude user
scope uses `--claude-channel-mode on`. Exact existing entries are no-ops. Any
conflict fails closed and is never removed or overwritten.

### 3. Generate managed configuration

```bash
npm run generate
npm run validate -- .local/openclaw.imessage.patch.json
```

Generated patch contains only managed gateway and iMessage channel policy. It is
not a full OpenClaw replacement.

### 4. Activate channel transactionally

Preview merge safety, then apply:

```bash
npm run activate
npm run activate -- --apply
```

Apply repeats privacy-safe preflight, backs up existing config, merges managed
gateway/iMessage fields, validates, enables bundled plugin, validates again, and
restarts gateway. Unrelated OpenClaw settings remain intact.

### 5. Probe readiness

```bash
npm run probe
```

Read-only probe requires policy, config, plugin, gateway, channel, and exactly one
running iMessage account to pass. It sends nothing.

### 6. Smoke-test one message

Dry-run validates recipient and allowlist without invoking `imsg`:

```bash
npm run smoke
```

For one deliberate fixed test message:

```bash
export IMESSAGE_TEST_CONFIRM="SEND_ONE_TEST_MESSAGE"
npm run smoke -- --send
unset IMESSAGE_TEST_CONFIRM
```

Message starts with `TEST:`, includes generated correlation UUID, and says no
response is needed. Send goes through iMessage only with SMS fallback disabled.

## Rollback and backups

Activation writes sibling backup named
`openclaw.json.backup.<timestamp>-<process-id>` before replacing config. Keep it
until `npm run probe` and optional smoke pass. On any post-mutation failure,
activator atomically restores exact backup and attempts one recovery restart.

If activation reports `rollback_failed`, do not rerun blindly. Stop gateway,
inspect newest backup locally, restore it to `OPENCLAW_CONFIG_PATH`, run
`openclaw config validate --json`, then restart gateway. Never paste config or
backup into public issue.

## Command reference

| Command | Mutation | Purpose |
|---|---:|---|
| `npm test` | No | Run Node built-in test suite |
| `npm run check` | No | Syntax-check every `scripts/**/*.mjs` and `test/**/*.mjs` |
| `npm run preflight` | No | Verify host transport prerequisites |
| `npm run configure-agents` | No | Preview Codex/Claude MCP registration |
| `npm run configure-agents -- --apply` | Yes | Add only absent MCP registrations |
| `npm run generate` | Writes `.local/` | Generate managed patch |
| `npm run activate` | No | Validate environment/readability/merge safety |
| `npm run activate -- --apply` | Yes | Apply channel transaction with rollback |
| `npm run probe` | No | Verify live channel readiness |
| `npm run smoke` | No | Validate one-send guardrails |
| `npm run smoke -- --send` | Sends once | Send and verify fixed test message |

## Public repository privacy

Public source contains placeholders only. Local generated patch contains real
allowlisted handles; OpenClaw config and backups can contain handles, tokens, and
other channel settings; `chat.db` contains message history. Keep all outside Git.

Before sharing logs or filing issues, remove handles, local usernames/paths,
configuration, account IDs, GUIDs, timestamps, message text, and CLI diagnostics.
Privacy-safe JSON output is intended for automation, but npm/shell errors outside
these scripts may still reveal local paths.

## Limitations

- macOS only for live Messages access; CI checks syntax/tests on Linux only.
- Basic mode intentionally omits private IMCore features.
- Group messaging is disabled.
- One running iMessage account is required by readiness probe.
- OpenClaw config must be strict JSON; commented JSON5 is refused.
- MCP configuration supports Codex and Claude CLI clients only.
- Smoke sends fixed text only, once, to exact allowlisted direct recipient.
- Scripts do not install permissions, disable SIP, send arbitrary content, or
  automatically resolve conflicting MCP/config state.

## Development and CI

```bash
npm test
npm run check
```

GitHub Actions runs both commands on Ubuntu with Node `22.22.3` and read-only
repository permissions. Project has zero runtime/test dependencies.

Official references: [OpenClaw installation](https://docs.openclaw.ai/install),
[OpenClaw iMessage channel](https://docs.openclaw.ai/channels/imessage), and
[`imsg` installation](https://github.com/openclaw/imsg/blob/main/docs/install.md).
