# Cameo Task Dispatcher Prototype

Owner-controlled proof that one structured Cameo job can launch one local Codex worker in an isolated worktree and retain reviewable evidence.

This is an owner-controlled Discord-to-Codex prototype. A constrained OCI control plane accepts authenticated slash commands, retains a durable queue, and posts results back to per-job Discord threads. An outbound-only Windows runner invokes the local `codex` executable in isolated worktrees using the owner's existing ChatGPT login. The OCI service never receives or copies Codex authentication.

The public repository is a sanitized source distribution. It intentionally excludes live configuration, credentials, deployment destinations, databases, job transcripts, logs, build archives, dependency directories, and generated worktrees. See [SECURITY.md](SECURITY.md) before deploying or reporting a vulnerability.

The planned authority and interface boundary is defined in `docs/dispatch-contract.md`. Request payload structure is published separately as `schemas/job.schema.json`; the runner's repository and permission configuration is never requester-controlled.

## Safety boundary

- The dispatcher configuration fixes the repository, base ref, worktree root, state root, Codex executable, and sandbox. A requester cannot override them.
- Request payloads contain only an objective, acceptance criteria, repository-relative scope, identity metadata, and an idempotent request ID.
- A single exclusive runner lock prevents concurrent workers.
- Every job gets a detached worktree at an exact resolved base commit.
- Worktrees and evidence are retained. The dispatcher does not clean, commit, push, create PRs, merge, launch the game, edit engine pins, or contact third parties.
- `danger-full-access` is rejected.
- Do not copy `%USERPROFILE%\\.codex\\auth.json` to CI, cloud hosting, another developer, or this project.

## Proven path

The complete read-only execution path has been exercised successfully through `/cameo-task`:

1. An allowlisted Discord user submits `/cameo-task` in the private `#agent-office` channel.
2. The OCI bot creates a durable job and a dedicated Discord thread.
3. The Windows runner opens an authenticated SSH loopback tunnel and claims one job.
4. Codex runs in a detached worktree at the owner-configured `upstream/master` commit.
5. The result returns to the same thread through the server-owned webhook persona, including job, run, base, validation, and risk provenance.
6. The worktree and local evidence are retained for review; no commit, push, PR, merge, or game launch occurs.

Mention-only intake has separately passed a queue-only production smoke: one `@Cameo Dispatcher` source message created one sourced job, acknowledgement, and bot-owned thread; status and cancellation persisted without starting Codex or creating a worktree. Its first real Aedis-submitted execution remains a pilot gate.

Infrastructure messages use the neutral `Cameo Dispatcher` bot. Worker results use the server-stamped `Blackrobe · Codex Worker` persona and a durable `[Blackrobe/Codex Worker]` text label.

## Discord intake

Conversational intake uses an immutable bot mention rather than a conventional prefix:

```text
@Cameo Dispatcher check PR #392 again and report whether it can cover the active RA and TD factions
```

The mention must be the first raw item in the message. Leading text, quotes, code blocks, lookalike Unicode text, edited historical messages, bot/webhook messages, other guilds, other channels, and every non-allowlisted user are ignored. Only Blackrobe and Aedis are admitted. The source guild, channel, message, and immutable author IDs are retained with the accepted task snapshot; source edits or deletion do not revise or cancel it.

Message Content remains disabled. The bot requests only the standard Guild Messages intent and relies on Discord's mentioned-message exception. discord.js message caching is set to zero. Attachments are rejected without download for this milestone.

Conversational jobs receive owner-controlled acceptance policy, use the Discord message ID for durable deduplication, and are capped at two outstanding jobs per user, five globally, and three submissions per user per ten minutes. Repeated rejection notices are suppressed for one minute.

Controls remain unambiguous slash commands:

- `/cameo-task` — structured task with explicit acceptance criteria;
- `/cameo-status` and `/cameo-cancel` — state and requester-owned queued cancellation;
- `/cameo-worker` — worker and pause availability;
- `/cameo-pause` and `/cameo-resume` — Blackrobe-only claim control.

`@Cameo Dispatcher help` returns usage without invoking Codex. Mention-form `status CAM-...` and `cancel CAM-...` only redirect to the exact slash commands; natural-language parsing never changes dispatcher control state.

## Local runner

1. Copy `config.example.json` to `config.json` and review its owner-controlled paths.
2. Run `npm test`.
3. Run:

   ```powershell
   node .\src\run-job.mjs .\config.json .\examples\local-readonly-job.json
   ```

4. Inspect `state\jobs\local-readonly-proof\status.json`, `events.jsonl`, `diagnostics.log`, and `final.json`.

Rerunning the same request ID returns the existing status instead of creating a second worktree or worker.

`src\worker-service.mjs` is the outbound-only Windows queue consumer. It requires `CAMEO_DISPATCHER_URL` and `CAMEO_RUNNER_TOKEN`; it does not invoke Codex when the queue is empty. Use `--once` for a single integration-test poll.

`scripts\invoke-worker.ps1` is the credential-safe launcher. It:

- opens a hidden SSH tunnel from Windows loopback to the OCI loopback API;
- decrypts the runner token from the current user's DPAPI-protected file only in memory;
- runs the consumer under Blackrobe's Windows account;
- removes the credential from the parent process environment and closes the tunnel on exit;
- exits after repeated transport/authentication failures so a supervisor can restart the complete tunnel-and-consumer pair.

Each Codex job also has an owner-controlled 60-minute maximum. An overrun is terminated, retained as `needs_attention`, and must be reviewed before any retry.

`scripts\supervise-worker.ps1` owns that bounded restart loop. `scripts\install-supervisor.ps1` registers it as the single `Cameo Agent Dispatcher Worker` logon task under Blackrobe's interactive Windows account. This user context is required for both DPAPI and the existing Codex login.

Use `scripts\stop-supervisor.ps1` for a deliberate local stop. Windows Task Scheduler's generic stop action does not reliably terminate the launcher child tree on this host; the wrapper stops the exact task, worker, and loopback-tunnel processes and fails closed if more than one matching process exists. For remote intake maintenance, use owner-only `/cameo-pause` first so no new queued job can be claimed.

Run one poll with:

```powershell
.\scripts\invoke-worker.ps1 -Once
```

## Remaining production gates

Completed operational evidence includes single-user supervision, owner pause/availability controls, empty polling without model use, server restart, tunnel-loss restart, active-job retained-result reconciliation, exact safe stop/restart, and bounded Windows child-tree termination.

Remaining gates are:

1. Exercise an Aedis-submitted mention job and a subsequent explicit slash-command clarification or replacement job.
2. Exercise a live Discord delivery failure/retry while confirming one stable job and delivery revision.
3. Run one controlled edit-and-test job before enabling write jobs generally; publication and merge remain separate owner-only actions.
4. Shadow the current browser check during a short real-task pilot before deliberate cutover.
