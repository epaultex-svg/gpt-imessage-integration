# Security policy

## Supported versions

Security fixes target the current `main` branch with OpenClaw `2026.6.5`, `imsg`
`0.14.1`, and the Node versions declared in `package.json`.

## Reporting a vulnerability

Do not open a public issue containing handles, Messages database data, local
paths, configuration, credentials, or command diagnostics. Use GitHub private
vulnerability reporting when the repository Security tab offers it. If private
reporting is unavailable, open a public issue containing no sensitive details and
ask the maintainer for a private contact channel.

## Security boundaries

This project is local-only. The gateway baseline binds to loopback, disables
Tailscale exposure, uses exact direct-message allowlists, disables groups and
channel-initiated configuration writes, and keeps SIP enabled in `imsg` basic
mode. Local OpenClaw configuration, backups, generated patches, `chat.db`, CLI
diagnostics, and handles remain sensitive even though this repository is public.

Never commit `.env.local`, generated patches, OpenClaw configuration, backups,
message exports, real handles, private paths, API keys, or tokens.
