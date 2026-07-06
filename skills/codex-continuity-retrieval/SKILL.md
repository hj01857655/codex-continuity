---
name: codex-continuity-retrieval
description: Retrieval workflow for codex-continuity. Search the existing Codex memories workspace for related past fixes, decisions, paths, and project context before solving a task that may benefit from prior memory.
metadata:
  short-description: Retrieve relevant prior memory before solving similar work
---

# Codex Continuity Retrieval

## Trigger

Use this skill when the current task would benefit from prior memory, for example:

1. The task mentions a bug, error, feature, path, repo, or decision that may have happened before
2. The task asks for consistency with previous work, earlier decisions, or project conventions
3. The task is broad enough that project-level memory context may help
4. The task touches files or modules that may have prior related notes
5. The task needs recent root-cause or decision history, not just a general summary

Do NOT use this skill for trivial one-off edits, pure formatting work, or when the current task is fully self-contained.

## Procedure

Before answering or coding:

1. Call `codex_continuity_index_status` first when the task may depend on prior memory quality, freshness, or workspace coverage
2. Identify the best retrieval anchor from the user's task:
   - error text
   - feature name
   - file/path names
   - repo or cwd name
   - key design terms
3. Choose the narrowest tool that fits:
   - broad repo context -> `codex_continuity_project_summary`
   - prior Codex session by thread name, user prompt, rollout content, or current task context -> `codex_continuity_session_context`; use `primary.digest` as the reusable context
   - locating sessions without loading workflow context -> `codex_continuity_session_search` with `include_digest: true`
   - general search by concept or error -> `codex_continuity_search`
   - touched files / modules -> `codex_continuity_related_files`
   - recent root causes / decisions -> `codex_continuity_recent_decisions`
   - inspect one returned artifact in full -> `codex_continuity_read_note`
4. If the task is likely to produce a new memory note or update an old one, run `codex_continuity_overlap` on the candidate summary/body before deciding whether this is genuinely new knowledge
5. Use the returned memory only as supporting context, not as unquestioned truth
6. Prefer current code over old memory when they conflict
7. Stop after 1-2 focused retrieval calls unless the first result clearly requires drilling into one note

## Tool selection guidance

- `codex_continuity_session_context`
  - Use for: loading prior Codex session context for the current task before answering or coding
  - Input: `query`, optionally `cwd`, `limit`
  - Output: `hasContext`, `primary`, `hits`, and hydrated `digests`
  - Follow-up: use `primary.digest` directly; do not manually re-run digest unless you need a different focus query

- `codex_continuity_project_summary`
  - Use for: new repo context, broad feature work, "what have we done here before"
  - Input: current `cwd`

- `codex_continuity_session_search`
  - Use for: locating prior Codex sessions by thread name, user prompt text, rollout content, bug text, or decision terms when you do not need the workflow context wrapper
  - Input: `query`, optionally `cwd`, `limit`, `include_digest`
  - Sources: combines `session_index.jsonl`, `history.jsonl`, and `sessions` / `archived_sessions` rollout JSONL files
  - Follow-up: prefer `include_digest: true` so each hit carries compressed reusable context; only call `codex_continuity_session_digest` separately when hydration is unavailable or you need to re-focus the digest query

- `codex_continuity_session_digest`
  - Use for: converting one matched Codex session into reusable context with `title`, `project`, `summary`, `relatedPaths`, and `rolloutPaths`
  - Input: `thread_id`, optionally `query`
  - Use the digest as the context source; only inspect raw rollout/session material if the digest is insufficient

- `codex_continuity_search`
  - Use for: bug text, feature/domain terms, known path fragments, config names
  - Input: `query`, optionally `cwd`, `types`, `paths`, `recent_days`

- `codex_continuity_related_files`
  - Use for: when you already know the touched files or modules
  - Input: `paths[]`, optionally `cwd`

- `codex_continuity_recent_decisions`
  - Use for: root cause, trade-off, rejected alternative, design rationale
  - Input: optionally `cwd`, `query`, `recent_days`

- `codex_continuity_read_note`
  - Use for: opening one returned note in full after a prior search hit
  - Input: relative memory path returned by the search tools

- `codex_continuity_session_note_draft`
  - Use for: turning a session digest into a candidate ad-hoc memory note with overlap recommendation
  - Input: `digest`, optionally `type`, `cwd`, `paths`, `limit`
  - Output: `slug`, `content`, `paths`, `rolloutPaths`, `overlap`

- `codex_continuity_overlap`
  - Use for: checking whether a candidate fix/decision/note would duplicate or heavily overlap existing memory
  - Input: candidate `content`, optionally `paths[]`, `cwd`

## Query guidance

- For prior sessions: start with `codex_continuity_session_context` when the current task may depend on old rollout/session work; use `primary.digest` before relying on the context
- For bugfixes: search by error text, failing behavior, touched paths, and root-cause terms
- For feature work: search by feature name, domain terms, and target module paths
- For project context: use the current repo/cwd with `codex_continuity_project_summary`
- For repeated files: start with `codex_continuity_related_files` using the relative path or basename
- For decisions: prefer `codex_continuity_recent_decisions` over a broad keyword-only search

## Notes

- `codex_continuity_session_context` is the workflow-level prior-session loader; prefer it over manually chaining `codex_continuity_session_search` and `codex_continuity_session_digest` for current-task context.

- A session search hit without `digest` is only a locator; a hydrated session digest is the reusable memory unit. Prefer digest output over raw transcript snippets when carrying context forward.
- Retrieved memory is advisory context, not a source of truth over the current repository
- If no useful memory is found, continue normally instead of forcing a match
- Prefer concise, high-signal retrieval; do not spam multiple broad queries
- Prefer file/path-aware retrieval when you already know the touched modules
- Read a full note only after a search tool produced a concrete hit path
- Prefer `codex_continuity_overlap` before writing or recommending a new memory note for repeated work
