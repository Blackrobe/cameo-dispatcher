# Security Policy

## Reporting a vulnerability

Do not open a public issue containing a vulnerability, credential, token, private Discord identifier, job transcript, or deployment detail.

Use GitHub private vulnerability reporting when it is enabled for this repository. Otherwise, contact the repository owner privately through an already established channel and include only the minimum reproduction information required.

## Deployment boundary

This repository contains source and tests, not a deployable credential bundle. Operators must supply their own:

- Discord bot token, application, guild, channel, and immutable user allowlists;
- server-owned Discord webhook;
- runner bearer token;
- SSH destination and host key trust;
- owner-local Codex login and DPAPI-protected runner credential;
- repository, worktree, state, sandbox, and runtime-limit configuration.

Never commit `.env` files, real configuration, DPAPI blobs, SQLite databases, job state, transcripts, logs, worktrees, build archives, SSH keys, or Codex authentication.

The reference deployment keeps the control-plane API on server loopback and reaches it through an authenticated SSH tunnel. Publication and merge authority remain outside the dispatcher.

For write jobs, the SSH tunnel is closed before either the implementation model or independent reviewer starts. Codex ignores user configuration, uses the elevated Windows sandbox, has command network disabled, and loads no apps, web search, or MCP dependencies. Worktrees live on a separate ACL root from dispatcher state and credentials. Only the controller process can use GitHub credentials, and it is limited to a deterministic branch and draft PR in the configured repository. Merge is never automated.
