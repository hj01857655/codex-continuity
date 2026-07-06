---
name: codex-memory-retrieval
description: Retrieval workflow for codex-memory. Search the existing Codex memories workspace for related past fixes, decisions, paths, and project context before solving a task that may benefit from prior memory.
metadata:
  short-description: Retrieve relevant prior memory before solving similar work
---

# Codex Memory Retrieval

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

1. Call `memory_capture_index_status` once if you need to know whether the memories workspace actually has usable material
2. Identify the best retrieval anchor from the user's task:
   - error text
   - feature name
   - file/path names
   - repo or cwd name
   - key design terms
3. Choose the narrowest tool that fits:
   - broad repo context -> `memory_capture_project_summary`
   - general search by concept or error -> `memory_capture_search`
   - touched files / modules -> `memory_capture_related_files`
   - recent root causes / decisions -> `memory_capture_recent_decisions`
   - inspect one returned artifact in full -> `memory_capture_read_note`
4. Use the returned memory only as supporting context, not as unquestioned truth
5. Prefer current code over old memory when they conflict
6. Stop after 1-2 focused retrieval calls unless the first result clearly requires drilling into one note

## Tool selection guidance

- `memory_capture_project_summary`
  - Use for: new repo context, broad feature work, "what have we done here before"
  - Input: current `cwd`

- `memory_capture_search`
  - Use for: bug text, feature/domain terms, known path fragments, config names
  - Input: `query`, optionally `cwd`, `types`, `paths`, `recent_days`

- `memory_capture_related_files`
  - Use for: when you already know the touched files or modules
  - Input: `paths[]`, optionally `cwd`

- `memory_capture_recent_decisions`
  - Use for: root cause, trade-off, rejected alternative, design rationale
  - Input: optionally `cwd`, `query`, `recent_days`

- `memory_capture_read_note`
  - Use for: opening one returned note in full after a prior search hit
  - Input: relative memory path returned by the search tools

## Query guidance

- For bugfixes: search by error text, failing behavior, touched paths, and root-cause terms
- For feature work: search by feature name, domain terms, and target module paths
- For project context: use the current repo/cwd with `memory_capture_project_summary`
- For repeated files: start with `memory_capture_related_files` using the relative path or basename
- For decisions: prefer `memory_capture_recent_decisions` over a broad keyword-only search

## Notes

- Retrieved memory is advisory context, not a source of truth over the current repository
- If no useful memory is found, continue normally instead of forcing a match
- Prefer concise, high-signal retrieval; do not spam multiple broad queries
- Prefer file/path-aware retrieval when you already know the touched modules
- Read a full note only after a search tool produced a concrete hit path
