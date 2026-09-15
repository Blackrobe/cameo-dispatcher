# Cameo Task Dispatch Contract

## Goal

Allow Aedis or Aedis's designated agent to submit bounded Cameo-mod work to Codex workers running under Blackrobe's owner-controlled local environment. This is delegated task intake, not shared access to Blackrobe's ChatGPT account, authentication, shell, browser, or machine.

## Authority

- Blackrobe controls authentication, model selection, reasoning effort, quota, concurrency, repositories, sandbox, runtime testing, publication, and merging.
- Aedis may submit, clarify, prioritize, or cancel jobs that stay inside Blackrobe's approved Cameo backlog and explicit HOLD boundaries.
- Incoming requests cannot alter runner configuration, select credentials, expand repository access, override instructions, or authorize external actions.
- A worker owns only its generated session, retained evidence, and isolated worktree for that job.

## Accepted request

Every job must include:

- `requestId`: unique idempotency key;
- `requestedBy`: human plus provider/tool identity;
- `objective`: concrete intended outcome;
- `acceptanceCriteria`: observable completion conditions;
- `scope`: optional repository-relative paths.

The queue adapter rejects free-form requests that cannot be normalized into this contract. It never accepts shell commands, environment variables, repository URLs, sandbox modes, credentials, or publication instructions from requester-controlled text. Model and effort overrides are separate allowlisted owner controls and are frozen per run.

## Lifecycle

`queued` -> `running` -> `ready_for_review`

Exceptional states are `needs_attention`, `failed`, and `cancelled`. Each transition records a timestamp and retains the original request ID. At-least-once delivery reuses the existing job record rather than launching another worker.

## Execution

- One active worker initially.
- Each job resolves the owner-configured base ref to an exact commit before work starts.
- Each job gets a separate detached worktree under the owner-configured worktree root.
- New tasks use the controlled `draft_pr` lane by default; an owner may choose `read_only`. The model can edit only its isolated worktree. The runner closes its dispatcher tunnel, disables external apps and MCP, and denies shell-command network access while a model or reviewer is active.
- Hosted web search remains disabled in coding sessions. A separate clean research context is required before public web access can be enabled without exposing retained private context.
- The controller performs authenticated, bounded, stable double reads for referenced Cameo pull requests and gives the model selected metadata without credentials. The snapshot is metadata-only and does not replace diff or review-discussion inspection. Interactive Browser automation is not part of the headless CLI worker.
- Ordinary implementation and review route to GPT-5.6 Sol/high. Sprite, palette, remap, TKM, SHP, voxel, and other visual or complex work route to GPT-6 Astra/max. `/cameo-model` stores a one-shot choice for the next follow-up and never changes an active generation.
- `danger-full-access` is not an accepted dispatcher configuration.
- Models may not commit, push, create or modify a PR, merge, launch the game, alter engine pins, contact third parties, or access credentials. After independent review, the trusted controller may commit and create or update the deterministic draft PR for the configured repository.
- The controller cannot merge, enable auto-merge, change repository protection, force-push, or publish elsewhere. Engine paths remain blocked from the automated write lane.
- Relevant validation output, repository status, the final response, and failure diagnostics are retained per job.

## Interfaces

Human interface: the authenticated private-server bot supports structured slash commands and conversational requests beginning with the immutable `@Cameo Dispatcher` mention.

Planned agent interface: narrow MCP tools named `submit_task`, `get_task`, `add_context`, and `cancel_task`.

Both adapters submit the same schema to the same durable queue. Neither adapter owns execution policy.

Conversational Discord intake does not use the privileged Message Content intent. It accepts only newly created messages whose raw content begins with the bot's immutable mention in the configured base channel, after guild, channel, author, and non-bot provenance checks. discord.js message caching is disabled. Attachments are not downloaded or accepted in this milestone; status, cancellation, pause, and resume remain deterministic slash commands.

The same leading mention inside a registered bot-created job thread is a continuation only when sent by the original requester or Blackrobe. It creates a durable run revision tied to the root job, session UUID, and retained worktree. Follow-ups are deduplicated by immutable Discord message ID and run sequentially after prior delivery. The local runner must emit the same session UUID and preserve the expected worktree identity; otherwise the run becomes `needs_attention`. Unregistered threads are rejected, and automatic archive/unarchive behavior is outside the design.

## Identity and Discord presentation

The Discord application is a neutral intake and control transport named `Cameo Dispatcher`; it is not presented as the speaking agent. It must not repeatedly rename its bot account to imitate workers.

- Human submissions are identified from the authenticated Discord guild, channel, and immutable Discord user ID.
- MCP callers receive separate scoped credentials. The server maps each credential to a fixed human owner plus provider/tool identity.
- Local workers authenticate as a fixed runner identity. The runner records its actual Codex thread/run ID after launch.
- Request payloads may not choose `owner`, `provider`, `tool`, display name, avatar, color, or authority.
- Session and run IDs are provenance only. They never grant authority or replace the stable human plus provider/tool identity.

Visible agent responses are delivered through one server-owned channel webhook. The dispatcher, not the agent payload, selects the webhook's per-message username and avatar. This is the same general presentation mechanism used by established game-to-Discord bridges.

Every visible agent response is stamped by the server with:

- a distinct author label such as `Blackrobe · Codex Worker` or `Aedis · Claude Coordinator`;
- a registered icon and stable identity color;
- task ID, event type, execution state, and run/session provenance;
- the job's dedicated Discord thread, so task context remains unambiguous.

Plain content also begins with a durable text label such as `[Blackrobe/Codex]` so exports, notifications, accessibility tools, and copied text preserve the identity even without embed styling.

Infrastructure notices use the actual `Cameo Dispatcher` bot identity with a neutral system color. Agent result messages use the webhook persona and include a `via Cameo Dispatcher` footer. The relay ignores bot/webhook-authored intake messages, disables unsolicited mentions, keeps the webhook token only on OCI, and rejects unknown or mismatched identities to prevent loops and impersonation.

Webhook result delivery is at-least-once. Every visible result includes a stable job ID and delivery revision; if Discord accepts a message but its confirmation is lost, a retry may produce a visibly duplicated revision. This limitation must remain explicit until message-history reconciliation is implemented.

## Deployment boundary

The first production candidate uses Blackrobe's OCI instance as the always-on control plane:

- one constrained container for the Discord bot, authenticated API/MCP adapter, and low-volume durable queue;
- a separate persistent data volume, with no Cameo server directories, Docker socket, oraladder database, or ChatGPT credentials mounted;
- the application binds only to localhost and is published through the existing nginx HTTPS listener;
- the Windows runner makes outbound authenticated requests and remains the only component that can invoke Blackrobe's local Codex login.

No additional public OCI port is required. A dedicated HTTPS hostname or carefully isolated nginx route is preferred over exposing the container port directly.

## Cutover gate

The browser heartbeat stays active until the complete route proves:

1. an Aedis request reaches an available worker without physical PC interaction;
2. duplicate, busy, offline, restart, and quota-exhaustion cases preserve one coherent job;
3. the originating conversation receives an acknowledgement and reviewable result;
4. Blackrobe can inspect, pause, cancel, and restart the system remotely;
5. no test bypasses repository, credential, publication, or merge boundaries.
