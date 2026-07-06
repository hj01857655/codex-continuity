# codex-continuity

`codex-continuity` is a Codex plugin bundle that enhances the stock Codex memory workflow without replacing Codex's built-in consolidation pipeline.

It adds three layers around the existing `~/.codex/memories` workspace:

- structured capture skills for writing high-signal ad-hoc memory notes
- an MCP sidecar for searching memories, related files, recent decisions, overlap candidates, and prior Codex sessions
- lifecycle hooks for read-only session context injection and stop-time ad-hoc memory settling

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
│   └── hooks.json               # SessionStart, UserPromptSubmit, and Stop lifecycle hooks
├── sidecar/                     # Node.js MCP stdio sidecar and hook helpers
│   ├── server.js                # MCP protocol shell
│   ├── tools.js                 # Tool registry
│   ├── session.js               # Codex session search/digest support
│   ├── session-start-hook.js    # Startup prior-session context hook
│   ├── user-prompt-submit-hook.js # Prompt-time prior-session context hook
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
- workflow-level prior session context loading
- session digest to ad-hoc note draft generation
- reviewed existing-note update drafts
- hash-protected existing-note update apply
- explicit core memory update drafts for `MEMORY.md` / `memory_summary.md`
- hash-protected core memory update apply
- safe ad-hoc note write / settle helpers for lifecycle hooks

### Session workflow support

`SessionStart` runs a read-only startup hook that loads project-related prior session context from cwd, excludes the current session id, and returns digest text through hook `additionalContext`. It is fail-open and never writes memory.

`UserPromptSubmit` runs a read-only prompt-time hook that looks up related prior Codex sessions from the current prompt and cwd, excludes the current session id, and returns relevant digest text through hook `additionalContext`. The hook is fail-open and never writes memory.

`Stop` runs a fail-open settling hook that turns the final assistant message into a structured ad-hoc note update. Its automatic path writes only under `extensions/ad_hoc/notes/` and updates close ad-hoc notes through hash-protected apply; it does not silently edit `MEMORY.md`, `memory_summary.md`, or rollout summaries.

`codex_continuity_core_memory_update_draft` and `codex_continuity_core_memory_update_apply` provide the explicit core-memory correction path for `MEMORY.md` and `memory_summary.md`. Use them when those files are wrong or stale and the update is intentional; the apply step requires `expectedHash` to avoid overwriting concurrent Codex consolidation changes.

`codex_continuity_session_context` is the preferred workflow-level loader for prior Codex session context. It wraps session search with hydrated digests and returns `hasContext`, `primary`, `hits`, and `digests` so skills do not have to manually chain search and digest calls.

`codex_continuity_session_note_draft` turns one digest into an ad-hoc memory note draft, runs overlap detection, and returns `settling` guidance for whether to create a new note, update an existing note, or review a match first. It does not write durable memory directly; stock Codex ad-hoc notes and Phase 2 consolidation remain the long-term memory boundary.

`codex_continuity_note_update_draft` and `codex_continuity_note_update_apply` provide the reviewed old-note merge path. The draft tool reads an existing `extensions/ad_hoc/notes/*.md` note and returns full `updatedContent` plus an `expectedHash`; the apply tool writes the reviewed content only when the existing note hash still matches, preventing stale overwrites.

`codex_continuity_session_search` can combine:

- `session_index.jsonl`
- `history.jsonl`
- `sessions/**/*.jsonl`
- `archived_sessions/**/*.jsonl`

When called with `include_digest: true`, search hits include a reusable memory-shaped digest containing title, project, summary, related paths, and rollout paths. Use direct `codex_continuity_session_digest` only when you already have a specific thread id or need to re-focus the digest query.

## Install from Codex

This repository can act as its own Codex marketplace source:

```text
/plugins marketplace add hj01857655/codex-continuity
/plugin install codex-continuity@codex-continuity
```

For direct CLI installation, use:

```powershell
npx codex-marketplace add hj01857655/codex-continuity --plugins
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
- session digest generation and hydrated session-search digests
- workflow-level session context loading
- read-only `SessionStart` hook for project-level prior-session context injection
- read-only `UserPromptSubmit` hook for prompt-time prior-session context injection
- fail-open `Stop` hook for ad-hoc memory settling
- explicit `MEMORY.md` / `memory_summary.md` update flow with review + hash protection
- reviewed old-note update flow with `codex_continuity_note_update_draft` and hash-protected `codex_continuity_note_update_apply`
- session digest to ad-hoc note draft generation with overlap and `settling` guidance
- lifecycle hook tests for startup context injection, prompt-time context injection, stop-time note settling, and fail-open behavior
- capture/retrieval skills that prefer digest-shaped prior session context

Remaining Codex memory pain points:

- none in the session/memory continuity mainline; future work should be treated as product tuning, not a missing pain-point fix
