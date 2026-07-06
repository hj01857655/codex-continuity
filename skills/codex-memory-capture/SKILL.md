---
name: codex-memory-capture
description: Opt-in capture workflow for codex-memory. Write a structured ad-hoc memory note after completing a non-trivial task (bug fix verified, feature implemented, user confirms completion) when the session produced knowledge worth preserving across future sessions.
metadata:
  short-description: Auto-capture task decisions as ad-hoc memory notes after completion
---

# Codex Memory Capture

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
2. If the task clearly continues or revisits earlier work, use `memory_capture_search`, `memory_capture_related_files`, or `memory_capture_recent_decisions` once to check for closely related prior memory
3. Extract: the problem, the solution, the root cause or key decision, the delta from any prior memory you found, and the files changed
4. Build the slug from the core topic (e.g. `fix-session-manager-active-state`, `add-gateway-stream-support`)
5. Prefer the stock memories `add_ad_hoc_note` path/tooling when exposed; otherwise create the note file directly under `~/.codex/memories/extensions/ad_hoc/notes/`
6. Write the note using the exact structure above
7. Mention in your reply that a memory note was saved (one short line at the end)

If multiple distinct tasks were completed in one session, write one note per task (up to 3).

## Notes

- Do NOT ask the user for permission to capture. This plugin is itself the user's opt-in override.
- Do NOT edit `MEMORY.md`, `memory_summary.md`, or rollout summaries directly.
- Do NOT re-read the note file after writing it. Phase 2 will see note changes through the memories workspace diff, and the built-in `ad_hoc` consolidation instructions will fold them into durable memory.
- If prior memory exists, write the new note as an update with fresh outcome/delta instead of copying the older note.
- If the memory directory does not exist, create it silently.
- If writing fails (permissions, disk full), mention it briefly in the reply but do not block the answer.
