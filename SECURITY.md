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

For write jobs, the SSH tunnel is closed before either the implementation model or independent reviewer starts. Codex ignores user configuration, uses the elevated Windows sandbox, has shell-command network and hosted web search disabled, and loads no apps or MCP dependencies. Worktrees live on a separate ACL root from dispatcher state and credentials.

Only the controller process can use GitHub credentials. It performs bounded, stable double-read snapshots for referenced pull requests and builds a run-scoped immutable cache containing selected metadata, diffs, names, and checks. A local shim serves only `gh pr view`, `gh pr diff`, `gh pr checks`, and `gh issue view` for cached references; it has no credentials, network, or write path. Missing references, generic `gh api`, repository overrides, authentication operations, comments, reviews, PR creation, merge, and other model-side writes fail closed.

Controller publication is limited to the configured repository. Draft PR creation may follow an approved job. Closing and merging require a separate immutable Discord interaction from one of the two configured trusted developers. Natural wording is accepted only when it forms a clear imperative or polite request with one PR target; negation, conditions, questions, explanations, and ambiguity do not mutate GitHub. The Windows controller durably resolves and records the PR head SHA, head repository/branch, and base branch before mutation. Generic controls require an exact PR/head or exact upstream head/base branches. Merge uses GitHub's immediate REST merge with the expected SHA: unmet checks, reviews, protection, or queue requirements fail the action instead of enabling auto-merge. The controller never uses admin bypass, force-push, branch deletion, or an agent-supplied credential.
