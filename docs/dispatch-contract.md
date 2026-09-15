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

The queue adapter rejects free-form requests that cannot be normalized into this contract. It never accepts shell commands, environment variables, repository URLs, model names, sandbox modes, credentials, or publication instructions from the request payload.

## Lifecycle

`queued` -> `running` -> `ready_for_review`

Exceptional states are `needs_attention`, `failed`, and `cancelled`. Each transition records a timestamp and retains the original request ID. At-least-once delivery reuses the existing job record rather than launching another worker.

## Execution

- One active worker initially.
- Each job resolves the owner-configured base ref to an exact commit before work starts.
- Each job gets a separate detached worktree under the owner-configured worktree root.
- Initial pilot sandbox is `read-only`. A later owner decision may allow `workspace-write` for approved task classes.
- `danger-full-access` is not an accepted dispatcher configuration.
- No job may commit, push, create or modify a PR, merge, launch the game, alter engine pins, contact third parties, or access credentials unless Blackrobe separately authorizes that lane.
- Relevant validation output, repository status, the final response, and failure diagnostics are retained per job.

## Interfaces

Human interface: the authenticated private-server bot supports structured slash commands and conversational requests beginning with the immutable `@Cameo Dispatcher` mention.

Planned agent interface: narrow MCP tools named `submit_task`, `get_task`, `add_context`, and `cancel_task`.

Both adapters submit the same schema to the same durable queue. Neither adapter owns execution policy.

Conversational Discord intake does not use the privileged Message Content intent. It accepts only newly created messages whose raw content begins with the bot's immutable mention in the configured base channel, after guild, channel, author, and non-bot provenance checks. discord.js message caching is disabled. Attachments are not downloaded or accepted in this milestone; status, cancellation, pause, and resume remain deterministic slash commands.

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
