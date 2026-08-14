# OpenClaw + iMessage automation

Small, local-only scaffold for connecting OpenClaw to iMessage through
[`imsg`](https://github.com/steipete/imsg). It generates an allowlisted OpenClaw
configuration without committing phone numbers, Apple ID emails, or local paths.

## Safety profile

- OpenClaw gateway binds only to loopback.
- Direct messages require an exact handle allowlist.
- Group messages are disabled.
- iMessage-triggered configuration writes are disabled.
- `imsg` runs in basic mode. Keep System Integrity Protection (SIP) enabled; do
  not run `imsg launch`. Basic mode supports text/media send and receive but not
  private-API reactions, edits, unsends, effects, or group operations.
- Generated patch files live under `.local/`, which Git ignores.
- Applying a patch preserves unrelated OpenClaw settings and first creates a
  sibling backup of the existing configuration.

## Pinned versions

- OpenClaw `2026.6.5` (installed and locally verified compatibility baseline)
- `imsg` `0.14.1` (locally installed and verified)

See [`versions.json`](./versions.json). Install and permission setup are kept out
of this slice; no setup command here changes SIP or macOS security settings.

## Generate local configuration

Use environment variables or an untracked `.env.local` file loaded by your shell.
`PAUL_IMESSAGE_HANDLE`, `IMSG_CLI_PATH`, and `IMESSAGE_DB_PATH` are required.
Handles must be E.164 phone numbers or Apple ID email addresses. Optional extra
handles are comma-separated.

```bash
export PAUL_IMESSAGE_HANDLE="+15555550123"
export IMESSAGE_EXTRA_ALLOW_FROM="second-person@example.net"
export IMSG_CLI_PATH="/opt/homebrew/bin/imsg"
export IMESSAGE_DB_PATH="$HOME/Library/Messages/chat.db"
npm run generate
```

The generator writes `.local/openclaw.imessage.patch.json`, then validates it. To
choose another untracked output path:

```bash
npm run generate -- --output .local/custom-openclaw.json
npm run validate -- .local/custom-openclaw.json
```

The generated file is a managed patch, not a replacement for an existing
`openclaw.json`. Review it, then apply it explicitly:

```bash
npm run merge -- \
  --config "$HOME/.openclaw/openclaw.json" \
  --patch .local/openclaw.imessage.patch.json
```

Merge requires an existing strict-JSON configuration, creates
`openclaw.json.backup.<timestamp>-<pid>` beside it, preserves unrelated top-level,
gateway, and channel settings, and replaces only the managed
`channels.imessage` section. It refuses commented JSON5 instead of risking a lossy
rewrite. Keep the backup until OpenClaw validation and live probes pass.

The output is intentionally a complete, narrow baseline:

```json
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "channels": {
    "imessage": {
      "enabled": true,
      "cliPath": "/absolute/path/to/imsg",
      "dbPath": "/absolute/path/to/chat.db",
      "dmPolicy": "allowlist",
      "allowFrom": ["exact-handle@example.net"],
      "groupPolicy": "disabled",
      "groupAllowFrom": [],
      "configWrites": false
    }
  }
}
```

Example values above are documentation only. Validator rejects placeholder values
if they appear in a managed patch.

## Verify

Run privacy-safe transport checks before applying configuration:

```bash
npm run preflight
```

Preflight verifies macOS, pinned OpenClaw/`imsg` versions, OpenClaw's Node engine,
SIP, `imsg` basic mode, bundled `@openclaw/imessage`, and read access to one chat
database row. Output contains only pass/fail status, row count, and actionable
error codes; it never prints chat fields, message content, or handles. If
`FULL_DISK_ACCESS_REQUIRED` appears, grant Full Disk Access to the terminal or
agent host running preflight, then rerun it.

```bash
npm test
```

Schema choices follow OpenClaw's official [iMessage channel
documentation](https://docs.openclaw.ai/channels/imessage) and [gateway
configuration reference](https://docs.openclaw.ai/gateway/configuration-reference).
