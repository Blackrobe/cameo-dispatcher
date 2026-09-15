# Cameo Task Dispatcher Prototype

Owner-controlled Discord intake that launches local Codex work in isolated Cameo-mod worktrees and retains reviewable evidence.

This is an owner-controlled Discord-to-Codex prototype. A constrained OCI control plane accepts authenticated slash commands, retains a durable queue, and posts results back to per-job Discord threads. An outbound-only Windows runner invokes the local `codex` executable in isolated worktrees using the owner's existing ChatGPT login. The OCI service never receives or copies Codex authentication.

The public repository is a sanitized source distribution. It intentionally excludes live configuration, credentials, deployment destinations, databases, job transcripts, logs, build archives, dependency directories, and generated worktrees. See [SECURITY.md](SECURITY.md) before deploying or reporting a vulnerability.

The planned authority and interface boundary is defined in `docs/dispatch-contract.md`. Request payload structure is published separately as `schemas/job.schema.json`; the runner's repository and permission configuration is never requester-controlled.

## Safety boundary

- The dispatcher configuration fixes the repository, base ref, worktree root, state root, Codex executable, sandbox, GitHub repository, and controller credentials. A requester cannot override them.
- Request payloads contain only an objective, acceptance criteria, repository-relative scope, identity metadata, and an idempotent request ID.
- A single exclusive runner lock prevents concurrent workers.
- Every job gets a detached worktree at an exact resolved base commit.
- Worktrees and evidence are retained. Models never commit or publish. For a write job, a separate controller may commit and create or update one verified draft PR after independent review.
- `danger-full-access` is rejected.
- Do not copy `%USERPROFILE%\\.codex\\auth.json` to CI, cloud hosting, another developer, or this project.

## Proven path

The execution path supports read-only work and a contained edit-to-draft-PR lane:

1. An allowlisted Discord user submits `/cameo-task` in the private `#agent-office` channel.
2. The OCI bot creates a durable job and a dedicated Discord thread.
3. The Windows runner opens an authenticated SSH loopback tunnel and claims one job, then closes that tunnel before a model or reviewer starts.
4. Codex runs with elevated Windows sandboxing, external web/apps/MCP disabled, and no shell-command network access.
5. Before each run, the trusted controller snapshots referenced Cameo pull requests twice and builds an immutable per-run cache containing stable metadata, actual diffs, file names, and checks without exposing GitHub credentials. During the run, a local shim serves that cache through `gh pr view`, `gh pr diff`, `gh pr checks`, and `gh issue view` syntax.
6. A write candidate is independently reviewed and checked for exact HEAD, path scope, size, modes, and credential-like content.
7. The trusted controller creates or updates one deterministic draft PR; merge requires a separately authenticated trusted-developer instruction.
8. The result returns to the same thread with job, run, model, reviewer, base, validation, risk, session, and publication provenance.

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

- `/cameo-task` — structured task with explicit acceptance criteria and owner-only model, effort, and execution-mode overrides;
- `/cameo-status` and `/cameo-cancel` — state and requester-owned queued cancellation;
- `/cameo-model` — Blackrobe-only one-shot model and effort selection for the next follow-up in the current registered thread;
- `/cameo-github open|merge|close` — trusted-developer upstream PR control with exact branch or PR/head identity;
- `/cameo-worker` — worker and pause availability;
- `/cameo-pause` and `/cameo-resume` — Blackrobe-only claim control.

`@Cameo Dispatcher help` returns usage without invoking Codex. Mention-form `status CAM-...` and `cancel CAM-...` only redirect to the exact slash commands; natural-language parsing never changes dispatcher control state.

An authorized leading mention inside the SQLite-registered bot-created job thread creates a versioned follow-up run instead of a new root job. Either fixed trusted developer may continue or cancel the job. The Windows runner verifies the dispatcher-owned root record, exact session UUID, retained worktree, base commit, clean status, and emitted resume UUID before accepting the result. Concurrent follow-ups are queued and executed in revision order, with each revision retaining its own events, diagnostics, final result, and Discord delivery record. Missing or conflicting local state becomes `needs_attention`; no replacement session or worktree is created. Automatic session archiving is intentionally not used.

New tasks default to the draft-PR lane. Ordinary work routes to GPT-5.6 Sol at high effort. Sprite, palette, remap, TKM, SHP, voxel, and other visual work routes to GPT-6 Astra at max effort. The chosen model, effort, route, and run revision are frozen when submitted. `/cameo-model` affects only the next follow-up; it cannot mutate a generation already in progress.

Agents receive authenticated read-only snapshots for referenced pull requests in `cameo-mod/Cameo-mod`; GitHub credentials remain controller-only. They may use `gh pr view <number>`, `gh pr diff <number>`, `gh pr checks <number>`, and `gh issue view <number>` against an immutable cache refreshed before each run and reviewer. The shim labels the cache timestamp in the environment, rejects missing references, unsupported flags, other commands, and repository overrides, and never contacts GitHub itself. `gh api`, authentication commands, comments, reviews, PR creation, merge, and all other writes remain unavailable to the model.

Trusted-developer GitHub control is separate from model authority. In a registered task thread, Blackrobe or Aedis may naturally instruct `merge PR 400`, `please merge this PR`, `try to merge your pull request`, or the equivalent `close` action. The intent gate accepts only clear imperatives or polite requests; questions, explanations, negations, conditions, and ambiguous targets remain ordinary discussion. A typed PR must match the task publication or unique root reference. The controller then records the live PR head SHA, head owner/branch, and base branch before any mutation. `/cameo-github` can open an upstream branch-to-branch PR, merge an exact-head PR, or close one. Merge uses GitHub protections and never supplies admin bypass, auto-merge, force-push, branch deletion, or comments. Direct hosted web search stays disabled in coding sessions because resumed sessions may already contain private local context.

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

`scripts\invoke-worker.ps1` is the credential-safe launcher. Together with the worker service, it:

- opens a hidden SSH tunnel from Windows loopback to the OCI loopback API while idle, then closes it for the complete model/review phase;
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

Pilot gates are:

1. Exercise an Aedis-submitted mention job and a subsequent mention-based continuation in its registered job thread.
2. Exercise a live Discord delivery failure/retry while confirming one stable job and delivery revision.
3. Require the included containment and cross-model resume proofs before enabling the draft-PR lane on a worker host.
4. Shadow the current browser check during a short real-task pilot before deliberate cutover.
