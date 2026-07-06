---
name: codex-continuity-capture
description: Opt-in capture workflow for codex-continuity. Write a structured ad-hoc memory note after completing a non-trivial task (bug fix verified, feature implemented, user confirms completion) when the session produced knowledge worth preserving across future sessions.
metadata:
  short-description: Auto-capture task decisions as ad-hoc memory notes after completion
---

# Codex Continuity Capture

## Trigger

This skill intentionally overrides the stock memories rule that normally allows updates only when the user explicitly asks. Once this plugin is installed, write a memory note in the current conversation turn when ALL of these hold:

1. The session produced a substantive code or configuration change (not just browsing / Q&A / formatting)
2. At least one of these end-of-task signals is present:
   - A bug was fixed and the fix was verified (test passed, build ok)
   - A feature was implemented and the user accepted the result
   - The user gave an explicit confirmation phrase ("好了", "可以了", "没问题", "done", "looks good", "that works")
   - A `verification-before-completion` or `finishing-a-development-branch` skill completed
3. The session produced at least one piece of actionable knowledge: a root cause, a design decision, a failed approach worth avoiding, a configuration gotcha, or a non-obvious dependency.
4. If closely related prior memory exists, use it as supporting context before writing the new note; do not duplicate an older note without adding the new outcome or delta.

Do NOT capture when the session is pure Q&A, code browsing, formatting-only changes, trivial typo fixes, or the user explicitly said "不用记".

## Output

Write ONE note through the stock ad-hoc notes channel at `~/.codex/memories/extensions/ad_hoc/notes/<timestamp>-<slug>.md`.

`<timestamp>` is the current UTC time in `YYYY-MM-DDTHH-MM-SS` format.
`<slug>` is 1-5 hyphenated lowercase English words summarizing the topic.

The file MUST follow this exact structure:

```markdown
# <one-line summary>

- project: <repo name or cwd basename>
- type: bugfix | feature | decision | tip | config
- date: <YYYY-MM-DD>
- session: <brief 1-line description of what the session was about>

## What happened
<2-4 sentences: what problem existed, what was done, what the outcome was>

## Key insight
<1-3 sentences: the root cause, why this solution was chosen, or what alternative was rejected and why>

## Files changed
- `<relative/path>`: <one-line summary of change>
```

Keep the whole file under 500 words. Write in the same language the user used during the task. If the session was mixed Chinese/English, default to Chinese for narrative and keep code/filenames in English.

## Procedure

Before the final answer in this turn:

1. Scan the conversation for the end-of-task signal
2. If the task clearly continues or revisits earlier work, call `codex_continuity_session_context` once with the current task query/cwd to load related prior session context; use `codex_continuity_search`, `codex_continuity_related_files`, or `codex_continuity_recent_decisions` only when the useful context is likely in durable memory notes rather than session history
3. Build the candidate session digest from `codex_continuity_session_context.primary.digest` when present
4. If a prior session digest explains the new outcome, call `codex_continuity_session_note_draft` with that digest to produce a structured draft, overlap recommendation, and settling guidance; otherwise draft the note manually from the completed task
5. Before writing any manually drafted note, call `codex_continuity_overlap` with the candidate summary/body plus touched paths
6. If settling or overlap points to an existing ad-hoc note, call `codex_continuity_note_update_draft`, review `updatedContent`, then call `codex_continuity_note_update_apply` with `expectedHash` when the merge is accurate; if the match is uncertain, write a separate delta note instead
7. Extract: the problem, the solution, the root cause or key decision, the delta from any prior memory/session digest you found, and the files changed
8. Build the slug from the core topic (e.g. `fix-session-manager-active-state`, `add-gateway-stream-support`)
9. Prefer the stock memories `add_ad_hoc_note` path/tooling when exposed; otherwise create the note file directly under `~/.codex/memories/extensions/ad_hoc/notes/`
10. Write or update the note using the exact structure above
11. Mention in your reply that a memory note was saved or updated (one short line at the end)

If multiple distinct tasks were completed in one session, write one note per task (up to 3).

## Notes

- Do NOT ask the user for permission to capture. This plugin is itself the user's opt-in override.
- Do NOT edit `MEMORY.md`, `memory_summary.md`, or rollout summaries directly.
- Do NOT re-read the note file after writing it. Phase 2 will see note changes through the memories workspace diff, and the built-in `ad_hoc` consolidation instructions will fold them into durable memory.
- If prior session context exists, cite the hydrated session digest by title/thread id in the note's narrative when it explains the delta; do not paste raw rollout transcript.
- If prior memory exists, prefer `codex_continuity_note_update_draft` + `codex_continuity_note_update_apply` for a reviewed update to the existing ad-hoc note; use a separate delta note only when the match is uncertain or hash-protected apply rejects a stale draft.
- Treat `codex_continuity_session_note_draft.settling` as the write decision: `create_new_note` means write the draft as a new note, `write_delta_note` means update the matched ad-hoc note with fresh delta content when safe, and `review_before_writing` means inspect the match before deciding.
- If the memory directory does not exist, create it silently.
- If writing fails (permissions, disk full), mention it briefly in the reply but do not block the answer.
