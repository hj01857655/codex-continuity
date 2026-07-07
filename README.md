
# codex-continuity

`codex-continuity` is a Codex plugin bundle that enhances the stock Codex memory workflow without replacing Codex's built-in consolidation pipeline.

It adds three layers around the existing `~/.codex/memories` workspace:

- structured capture skills for writing high-signal ad-hoc memory notes
- an MCP sidecar for searching memories, related files, recent decisions, overlap candidates, and prior Codex sessions
- lifecycle hooks for automatic raw rollout archiving, session context injection, pre-compact ad-hoc checkpoint capture, and stop-time ad-hoc memory settling

## Repository layout

```text
codex-continuity/
├── .agents/
│   └── plugins/
│       └── marketplace.json     # Codex marketplace source manifest
├── .codex-plugin/
│   └── plugin.json              # Plugin manifest
├── .mcp.json                    # MCP server registration
├── hooks/
│   └── hooks.json               # SessionStart, UserPromptSubmit, PostToolUse, PreCompact, PostCompact, and Stop hooks
├── sidecar/                     # Node.js MCP stdio sidecar and hook helpers
│   ├── server.js                # MCP protocol shell
│   ├── tools.js                 # Tool registry
│   ├── session.js               # Codex session search/digest support
│   ├── session-start-hook.js    # Startup prior-session context hook
│   ├── user-prompt-submit-hook.js # Prompt-time context hook
│   ├── pre-compact-hook.js      # Pre-compaction transcript checkpoint note hook
│   ├── post-tool-use-hook.js     # Post-tool raw rollout archive hook
│   ├── post-compact-hook.js      # Post-compaction raw rollout archive hook
│   ├── stop-hook.js             # Stop-time ad-hoc memory settling hook
│   ├── index.js                 # Persistent memory index
│   ├── scoring.js               # Search ranking
│   ├── overlap.js               # Duplicate/overlap detection
│   └── server.test.js           # Node test suite
└── skills/
    ├── codex-continuity-capture/    # Capture workflow skill
    └── codex-continuity-retrieval/  # Retrieval workflow skill
```

## What it does

### Capture workflow

`skills/codex-continuity-capture/SKILL.md` writes one structured ad-hoc note after a non-trivial completed task when the session produced durable knowledge such as a root cause, design decision, rejected approach, or configuration gotcha.

Notes are written through the stock ad-hoc memory path:

```text
~/.codex/memories/extensions/ad_hoc/notes/
```

Codex's built-in consolidation remains responsible for folding those notes into long-term memory artifacts such as `MEMORY.md` and `memory_summary.md`.

### Retrieval workflow

`skills/codex-continuity-retrieval/SKILL.md` guides the assistant to search relevant prior memory before solving tasks that may depend on earlier decisions, bugs, files, or sessions.

The sidecar exposes tools for:

- memory index status
- project-oriented summaries
- general memory search
- related-file lookup
- recent decisions/root causes
- overlap detection before capture
- reading one memory note
- prior Codex session search and digest hydration
- session inventory across active and archived rollout roots
- session health checks for malformed rollouts, duplicate thread ids, and index mismatches
- raw rollout archive backup for strict no-loss protection
- workflow-level prior session context loading
- session digest to ad-hoc note draft generation
- reviewed existing-note update drafts
- hash-protected existing-note update apply
- explicit core memory update drafts for `MEMORY.md` / `memory_summary.md`
- hash-protected core memory update apply
- safe ad-hoc note write / settle helpers for lifecycle hooks

### Session workflow support

`SessionStart` runs a read-only startup hook that loads project-related prior session context from cwd, excludes the current session id, automatically archives raw rollout files, and returns a thin session-context projection through hook `additionalContext`. The hook payload now stays on stable `title` / `summary` / `relatedPaths` fields so Codex's own `additional_context` role handling, deduplication, and truncation remain the host-side source of truth. It is fail-open and never writes durable core memory.

`UserPromptSubmit` runs a prompt-time hook that looks up related prior Codex sessions from the current prompt and cwd, excludes the current session id, automatically archives raw rollout files, and returns the same thin session-context projection through hook `additionalContext`. It is read-only: Codex's own transcript and rollout files remain the full-fidelity source for active-session process facts.

`PostToolUse` runs after each tool completes and automatically archives raw rollout files. This is the main "边做边记" backup point for process facts that happen between prompts, compaction, and stop.

`PreCompact` runs before Codex replaces active history with a compacted summary. It automatically archives raw rollout files, reads the hook transcript path when available, and writes one standard ad-hoc checkpoint note under `extensions/ad_hoc/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md`, so stock Codex memory consolidation can consume the stage checkpoint while the original transcript/rollout remains the lossless record.

`PostCompact` runs after successful compaction and automatically archives raw rollout files again, preserving the post-compaction rollout state without injecting archive content into memory.

`Stop` runs a fail-open settling hook that automatically archives raw rollout files, combines the final assistant message with the Codex transcript tail when `transcript_path` is available, then turns that fuller source into a structured ad-hoc note update. Its automatic path writes only under `extensions/ad_hoc/notes/` and updates close ad-hoc notes through hash-protected apply, but settling also surfaces a reviewable core-memory promotion hint through `systemMessage` when the outcome looks stable enough for durable memory. The hook does not silently edit `MEMORY.md`, `memory_summary.md`, or rollout summaries.

Hook stdin compatibility note: real Codex hook invocations on Windows may prepend a UTF-8 BOM to stdin. `sidecar/session-start-hook.js`, `sidecar/user-prompt-submit-hook.js`, `sidecar/post-tool-use-hook.js`, `sidecar/pre-compact-hook.js`, `sidecar/post-compact-hook.js`, and `sidecar/stop-hook.js` therefore strip a leading `\uFEFF` before `JSON.parse`, so hook success does not depend on shell or transport quirks. The corresponding BOM-prefixed regression cases are covered in `sidecar/server.test.js`.

`codex_continuity_core_memory_update_draft` and `codex_continuity_core_memory_update_apply` provide the explicit core-memory correction and promotion path for `MEMORY.md` and `memory_summary.md`. `codex-continuity` now reads those files when building a promotion draft, proposes `updatedContent` automatically for stable session outcomes, and still requires explicit `expectedHash`-guarded apply so durable memory never changes silently.

`codex_continuity_session_context` is the preferred workflow-level loader for prior Codex session context. It wraps session search with hydrated digests and returns `hasContext`, `primary`, `hits`, and `digests` so skills do not have to manually chain search and digest calls.

`codex_continuity_session_note_draft` turns one digest into an ad-hoc memory note draft, runs overlap detection, returns `settling` guidance for whether to create a new note, update an existing note, or review a match first, and now also returns `coreMemoryPromotion` when the digest looks stable enough for `MEMORY.md` or `memory_summary.md`. Durable memory apply remains explicit; stock Codex ad-hoc notes and Phase 2 consolidation still own the final write boundary.

`codex_continuity_note_update_draft` and `codex_continuity_note_update_apply` provide the reviewed old-note merge path. The draft tool reads an existing `extensions/ad_hoc/notes/*.md` note and returns full `updatedContent` plus an `expectedHash`; the apply tool writes the reviewed content only when the existing note hash still matches, preventing stale overwrites.

`codex_continuity_session_search` can combine:

- `session_index.jsonl`
- `history.jsonl`
- `sessions/**/*.jsonl`
- `archived_sessions/**/*.jsonl`

When called with `include_digest: true`, search hits include a reusable memory-shaped digest containing title, project, summary, related paths, and rollout paths. Hook injection consumes a thinner projection of that digest; workflow tools keep the full shape, and session/note settling can now derive reviewable core-memory promotion drafts from it. Use direct `codex_continuity_session_digest` only when you already have a specific thread id or need to re-focus the digest query.

## Install from Codex

Use the dedicated marketplace source:

```text
/plugins marketplace add hj01857655/codex-continuity-marketplace
/plugin install codex-continuity@codex-continuity-marketplace
```

This repository can also act as its own Codex marketplace source:

```text
/plugins marketplace add hj01857655/codex-continuity
/plugin install codex-continuity@codex-continuity
```

For non-interactive CLI installation, add the marketplace from its tracked branch, then install the current plugin version exposed by that marketplace:

```powershell
codex plugin marketplace add hj01857655/codex-continuity-marketplace --ref main
codex plugin add codex-continuity@codex-continuity-marketplace
```

The source repository also exposes the plugin directly by release tag:

```powershell
codex plugin marketplace add hj01857655/codex-continuity --ref v0.1.5
codex plugin add codex-continuity@codex-continuity
```

## Development workflow

The source repository lives at:

```text
e:/VSCodeSpace/play/codex-continuity
```

The Codex plugin installation/runtime copy should live separately under:

```text
~/.codex/plugins/codex-continuity
```

Do not treat the plugin installation directory as the source repository. Keep Git history and GitHub remote configuration in this development repository.

## Git remote

The expected GitHub remote is:

```text
origin  https://github.com/hj01857655/codex-continuity.git
```

`main` is the stable branch. Use a development branch for ongoing feature work when changes become larger or riskier.

## Running tests

The sidecar test suite uses Node's built-in test runner:

```powershell
cd e:/VSCodeSpace/play/codex-continuity; node --test sidecar/server.test.js
```

## Current implementation status

Implemented:

- MCP stdio server shell
- modular sidecar runtime/files/text/index/scoring/overlap/tools/session layers
- persistent `codex-continuity-index.json` reuse and manifest invalidation
- project-aware retrieval using cwd path suffix signals
- memory overlap recommendations
- Codex session search across session index, prompt history, and rollout files
- session inventory across `~/.codex/sessions/` and `~/.codex/archived_sessions/`
- session health checks for malformed rollout files, duplicate thread ids, and session-index mismatches
- automatic raw rollout archive under `~/.codex/codex-continuity/raw_archive/` for strict no-loss backup, triggered by `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `PostCompact`, and `Stop`, and also exposed as `codex_continuity_raw_archive` for diagnostics/backfill
- session digest generation and hydrated session-search digests
- workflow-level session context loading
- read-only `SessionStart` hook for project-level prior-session context injection
- prompt-time `UserPromptSubmit` hook for read-only prior-session context injection
- fail-open `PreCompact` hook that reads Codex transcript data and writes a legal ad-hoc checkpoint note before active history is compacted
- fail-open `Stop` hook that combines the final assistant message with the Codex transcript tail before final ad-hoc memory settling
- explicit `MEMORY.md` / `memory_summary.md` update flow with review + hash protection
- reviewed old-note update flow with `codex_continuity_note_update_draft` and hash-protected `codex_continuity_note_update_apply`
- session digest to ad-hoc note draft generation with overlap, `settling` guidance, and reviewable `coreMemoryPromotion` drafts
- Stop-hook settling that can include transcript-tail facts, surface reviewable core-memory promotion guidance through `systemMessage`, and avoid silently writing durable memory
- lifecycle hook tests for startup context injection, prompt-time context injection, pre-compact ad-hoc checkpoint writing, stop-time note settling, fail-open behavior, and BOM-prefixed hook stdin compatibility
- install/runtime-copy validation for the same hook input contract used by real Codex hook invocations
- capture/retrieval skills that prefer digest-shaped prior session context

### Session inventory and no-loss hardening

Codex source defines rollout state by directory, not by a plugin-owned marker:

| Codex path | State | Continuity meaning |
|---|---|---|
| `~/.codex/sessions/` | active | normal, not archived session rollout source |
| `~/.codex/archived_sessions/` | archived | archived session rollout source |

Lossless process memory is handled by Codex transcript/rollout files. `codex-continuity` now indexes, checks, archives, summarizes, and writes legal ad-hoc checkpoint notes only at PreCompact / Stop boundaries.

The no-loss hardening layer has three implemented parts:

1. `codex_continuity_session_inventory`
   - scan both `sessions/` and `archived_sessions/`
   - return `threadId`, `path`, `archived`, `cwd`, `updatedAt`, `readable`, and `parseable`
   - treat `sessions/` as active and `archived_sessions/` as archived, matching Codex rollout behavior
2. `codex_continuity_session_health`
   - report unreadable files, malformed rollout files, duplicate thread ids, and session-index mismatches
   - verify recent sessions are searchable through the sidecar
3. `codex_continuity_raw_archive`
   - runs automatically from `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `PostCompact`, and `Stop`
   - remains callable as an MCP diagnostics/backfill tool
   - copy raw rollout files as backup
   - preserve active/archived state
   - never inject archive content directly and never write it under `extensions/ad_hoc/notes/`
   - act as the actual no-loss safety layer when Codex source logs are cleaned up, moved, or damaged
