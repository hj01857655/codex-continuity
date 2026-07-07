const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const {
  createRuntime,
  buildIndex,
  findOverlapHits,
  codexContinuityCoreMemoryUpdateApply,
  codexContinuityCoreMemoryUpdateDraft,
  codexContinuityOverlap,
  codexContinuityNoteUpdateApply,
  codexContinuityNoteUpdateDraft,
  queryDocuments,
  codexContinuitySessionSearch,
  codexContinuitySessionDigest,
  codexContinuitySessionContext,
  codexContinuitySessionNoteDraft,
} = require('./server');

function makeTempMemoriesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-continuity-test-'));
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function writeJsonl(root, relativePath, records) {
  writeFile(root, relativePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

test('buildIndex persists and reuses index when files are unchanged', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(memoriesRoot, 'memory_summary.md', 'v1\n# Summary\n- project: demo\nFix login token refresh bug\n');
  writeFile(memoriesRoot, 'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md', '# Fix login\n\n- project: demo\n- session: token refresh\n\n## What happened\nFixed login token refresh.\n');

  const runtime = createRuntime({ memoriesRoot });
  const first = buildIndex(runtime);
  const second = buildIndex(runtime);

  assert.equal(first.documents.length, 2);
  assert.equal(second.documents.length, 2);
  assert.equal(second.meta.reused, true);
  assert.equal(second.meta.rebuilt, false);
  assert.match(second.meta.indexPath, /codex-continuity-index\.json$/);
});

test('buildIndex invalidates cache when a memory file changes', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  const notePath = writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md',
    '# Fix login\n\n- project: demo\n- session: token refresh\n\n## What happened\nFixed login token refresh.\n',
  );

  const runtime = createRuntime({ memoriesRoot });
  const first = buildIndex(runtime);
  fs.writeFileSync(notePath, '# Fix login\n\n- project: demo\n- session: token refresh\n\n## What happened\nFixed login token refresh again with cookie sync.\n', 'utf8');
  const second = buildIndex(runtime);

  assert.equal(first.meta.rebuilt, true);
  assert.equal(second.meta.rebuilt, true);
  assert.equal(second.meta.reused, false);
});

test('findOverlapHits surfaces similar notes using content and file paths', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md',
    '# Fix login token refresh\n\n- project: demo\n- session: auth token refresh\n\n## What happened\nFixed login token refresh for expired cookies.\n\n## Files changed\n- `src/auth/token.ts`: repair refresh path\n',
  );
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-05-00-theme-fix.md',
    '# Adjust theme\n\n- project: demo\n- session: dark mode\n\n## What happened\nTweaked color tokens.\n',
  );

  const runtime = createRuntime({ memoriesRoot });
  const index = buildIndex(runtime);
  const hits = findOverlapHits(index, {
    content: 'Fix login token refresh for expired cookies and retry session handling.',
    paths: ['src/auth/token.ts'],
    cwd: 'e:/VSCodeSpace/play/demo',
    limit: 3,
  });

  assert.equal(hits.length > 0, true);
  assert.equal(hits[0].path, 'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md');
  assert.equal(hits[0].overlapScore > hits[hits.length - 1].overlapScore, true);
});

test('codexContinuityOverlap recommends updating an existing note for high-confidence duplicates', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md',
    '# Fix login token refresh\n\n- project: demo\n- session: auth token refresh\n\n## What happened\nFixed login token refresh for expired cookies and stale session retries.\n\n## Files changed\n- `src/auth/token.ts`: repair refresh path\n',
  );

  const runtime = createRuntime({ memoriesRoot });
  const overlap = codexContinuityOverlap(runtime, {
    content: 'Fix login token refresh for expired cookies and stale session retries.',
    paths: ['src/auth/token.ts'],
    cwd: 'e:/VSCodeSpace/play/demo',
    limit: 3,
  });

  assert.equal(overlap.recommendation.action, 'update_existing');
  assert.equal(overlap.recommendation.confidence, 'high');
  assert.equal(overlap.recommendation.primaryMatch.path, 'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md');
});

test('queryDocuments prefers project hints that match the current cwd path, not only the basename', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-00-00-right-project.md',
    '# Right project memory\n\n- project: play/codex-continuity\n- session: retrieval tuning\n\n## What happened\nAdjusted retrieval tuning for the active codex-continuity repo.\n',
  );
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-10-00-wrong-project.md',
    '# Wrong project memory\n\n- project: archive/codex-continuity\n- session: old repo\n\n## What happened\nOlder unrelated codex-continuity work from another path.\n',
  );

  const runtime = createRuntime({ memoriesRoot });
  const index = buildIndex(runtime);
  const result = queryDocuments(index, {
    query: 'codex-continuity retrieval',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    limit: 2,
  });

  assert.equal(result.hits[0].path, 'extensions/ad_hoc/notes/2026-07-06T10-00-00-right-project.md');
});

test('queryDocuments breaks ties with full cwd path hints when note content is otherwise identical', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  const sharedBody = '# Shared auth note\n\n- session: auth retry\n\n## What happened\nFixed session retry handling for auth refresh.\n';
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-20-00-right-project.md',
    `# Shared auth note\n\n- project: play/codex-continuity\n${sharedBody}`,
  );
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T10-21-00-wrong-project.md',
    `# Shared auth note\n\n- project: archive/codex-continuity\n${sharedBody}`,
  );

  const runtime = createRuntime({ memoriesRoot });
  const index = buildIndex(runtime);
  const result = queryDocuments(index, {
    query: 'auth retry refresh',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    limit: 2,
  });

  assert.equal(result.hits[0].path, 'extensions/ad_hoc/notes/2026-07-06T10-20-00-right-project.md');
});

test('codexContinuitySessionSearch combines session index, prompt history, and rollout content', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const threadId = '00000000-0000-0000-0000-000000000123';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: threadId, thread_name: 'Fix gateway retry loop', updated_at: '2026-07-06T10:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: threadId, ts: 1783332000, text: 'why does gateway retry loop never stop?' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/rollout.jsonl', [
    { type: 'session_meta', id: threadId, cwd: 'e:/VSCodeSpace/play/ai-gateway' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Root cause was stale retry state in gateway stream handling.' }] } },
  ]);

  const runtime = createRuntime({ codexHome, memoriesRoot: path.join(codexHome, 'memories') });
  const result = codexContinuitySessionSearch(runtime, {
    query: 'gateway stale retry state',
    cwd: 'e:/VSCodeSpace/play/ai-gateway',
    limit: 5,
  });

  assert.equal(result.hitCount, 1);
  assert.equal(result.hits[0].threadId, threadId);
  assert.equal(result.hits[0].name, 'Fix gateway retry loop');
  assert.equal(result.hits[0].sources.includes('session_index'), true);
  assert.equal(result.hits[0].sources.includes('history'), true);
  assert.equal(result.hits[0].sources.includes('rollout'), true);
});

test('codexContinuitySessionDigest compresses a matched session into reusable memory shape', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const threadId = '00000000-0000-0000-0000-000000000456';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: threadId, thread_name: 'Repair auth refresh regression', updated_at: '2026-07-06T11:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: threadId, ts: 1783335600, text: 'auth refresh fails after cookie rotation' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/auth.jsonl', [
    { type: 'session_meta', id: threadId, cwd: 'e:/VSCodeSpace/play/ai-gateway' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Root cause was stale refresh token cache after cookie rotation.' }] } },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Changed src/auth/token.ts to clear stale cache before retry.' }] } },
  ]);

  const runtime = createRuntime({ codexHome, memoriesRoot: path.join(codexHome, 'memories') });
  const digest = codexContinuitySessionDigest(runtime, {
    thread_id: threadId,
    query: 'auth refresh stale cache',
  });

  assert.equal(digest.threadId, threadId);
  assert.equal(digest.title, 'Repair auth refresh regression');
  assert.equal(digest.project, 'ai-gateway');
  assert.match(digest.summary, /stale refresh token cache/i);
  assert.equal(digest.relatedPaths.includes('src/auth/token.ts'), true);
});

test('codexContinuitySessionSearch can hydrate top hits with reusable digests', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const threadId = '00000000-0000-0000-0000-000000000789';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: threadId, thread_name: 'Tune capture workflow', updated_at: '2026-07-06T12:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: threadId, ts: 1783339200, text: 'capture workflow should reuse prior session digest' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/capture.jsonl', [
    { type: 'session_meta', id: threadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Decision: session search should surface digest context for capture workflow.' }] } },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Changed skills/codex-continuity-capture/SKILL.md to call digest after search.' }] } },
  ]);

  const runtime = createRuntime({ codexHome, memoriesRoot: path.join(codexHome, 'memories') });
  const result = codexContinuitySessionSearch(runtime, {
    query: 'capture workflow digest context',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    include_digest: true,
    limit: 5,
  });

  assert.equal(result.hitCount, 1);
  assert.equal(result.hits[0].threadId, threadId);
  assert.equal(result.hits[0].digest.title, 'Tune capture workflow');
  assert.match(result.hits[0].digest.summary, /digest context/i);
  assert.equal(result.hits[0].digest.relatedPaths.includes('skills/codex-continuity-capture/SKILL.md'), true);
});

test('codexContinuitySessionContext returns hydrated prior session context for the current task', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const threadId = '00000000-0000-0000-0000-000000000abc';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: threadId, thread_name: 'Fix session note drafting', updated_at: '2026-07-06T13:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: threadId, ts: 1783342800, text: 'session note draft should reuse related session context' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/note-draft.jsonl', [
    { type: 'session_meta', id: threadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Root cause was missing orchestration between session search and capture note drafting.' }] } },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Changed sidecar/session.js and sidecar/tools.js to expose context helpers.' }] } },
  ]);

  const runtime = createRuntime({ codexHome, memoriesRoot: path.join(codexHome, 'memories') });
  const context = codexContinuitySessionContext(runtime, {
    query: 'session note draft orchestration',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    limit: 3,
  });

  assert.equal(context.hasContext, true);
  assert.equal(context.primary.threadId, threadId);
  assert.equal(context.primary.digest.title, 'Fix session note drafting');
  assert.equal(context.digests[0].relatedPaths.includes('sidecar/session.js'), true);
});

test('codexContinuitySessionContext returns thin hook projection for hook mode', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const threadId = '00000000-0000-0000-0000-000000000abd';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: threadId, thread_name: 'Thin hook context', updated_at: '2026-07-06T13:30:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: threadId, ts: 1783344600, text: 'hook mode should reuse thin session context projection' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/hook-thin.jsonl', [
    { type: 'session_meta', id: threadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Hook projection should keep only stable session context fields.' }] } },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Changed sidecar/session.js and sidecar/session-start-hook.js to shrink hook payloads.' }] } },
  ]);

  const runtime = createRuntime({ codexHome, memoriesRoot: path.join(codexHome, 'memories') });
  const context = codexContinuitySessionContext(runtime, {
    query: 'thin hook session context projection',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    limit: 3,
    context_mode: 'hook',
  });

  assert.equal(context.primary.threadId, threadId);
  assert.equal(context.primary.digest.project, 'codex-continuity');
  assert.deepEqual(context.digests[0], {
    threadId,
    title: 'Thin hook context',
    summary: 'Hook projection should keep only stable session context fields.',
    relatedPaths: ['sidecar/session.js', 'sidecar/session-start-hook.js'],
  });
});

test('session start hook emits read-only prior session context and excludes the current thread', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const previousThreadId = '00000000-0000-0000-0000-000000000333';
  const currentThreadId = '00000000-0000-0000-0000-000000000444';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: previousThreadId, thread_name: 'Prior startup context', updated_at: '2026-07-06T15:00:00Z' },
    { id: currentThreadId, thread_name: 'Current startup context', updated_at: '2026-07-06T15:10:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: previousThreadId, ts: 1783350000, text: 'codex-continuity recent decisions root cause session context' },
    { session_id: currentThreadId, ts: 1783350600, text: 'current startup context should be excluded' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/startup-previous.jsonl', [
    { type: 'session_meta', id: previousThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Prior startup decision: SessionStart should preload read-only context.' }] } },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/startup-current.jsonl', [
    { type: 'session_meta', id: currentThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Current startup context must be excluded.' }] } },
  ]);

  const hookPath = path.join(__dirname, 'session-start-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: currentThreadId,
      cwd: 'e:/VSCodeSpace/play/codex-continuity',
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /^Prior session context for this project:/);
  assert.match(output.hookSpecificOutput.additionalContext, /- title: Prior startup context/);
  assert.match(output.hookSpecificOutput.additionalContext, /- summary: Prior startup decision: SessionStart should preload read-only context\./);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Current startup context/);
});

test('user prompt submit hook emits read-only prior session context and excludes the current thread', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const previousThreadId = '00000000-0000-0000-0000-000000000111';
  const currentThreadId = '00000000-0000-0000-0000-000000000222';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: previousThreadId, thread_name: 'Prior prompt context', updated_at: '2026-07-06T14:00:00Z' },
    { id: currentThreadId, thread_name: 'Current prompt context', updated_at: '2026-07-06T14:10:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: previousThreadId, ts: 1783346400, text: 'prompt hook should inject prior session context' },
    { session_id: currentThreadId, ts: 1783347000, text: 'prompt hook should not inject current session context' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/previous.jsonl', [
    { type: 'session_meta', id: previousThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Prior decision: UserPromptSubmit hook stays read-only and uses additionalContext.' }] } },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/current.jsonl', [
    { type: 'session_meta', id: currentThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Current session context must be excluded from prior context injection.' }] } },
  ]);

  const hookPath = path.join(__dirname, 'user-prompt-submit-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: currentThreadId,
      cwd: 'e:/VSCodeSpace/play/codex-continuity',
      prompt: 'prompt hook inject prior session context',
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /^Prior session context for this prompt:/);
  assert.match(output.hookSpecificOutput.additionalContext, /- title: Prior prompt context/);
  assert.match(output.hookSpecificOutput.additionalContext, /- summary: Prior decision: UserPromptSubmit hook stays read-only and uses additionalContext\./);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Current prompt context/);
});

test('session start hook accepts BOM-prefixed JSON input', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const previousThreadId = '00000000-0000-0000-0000-000000000311';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: previousThreadId, thread_name: 'Prior startup context', updated_at: '2026-07-06T15:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: previousThreadId, ts: 1783350600, text: 'prior startup context should still parse with BOM input' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/startup-bom.jsonl', [
    { type: 'session_meta', id: previousThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Prior startup context survives BOM-prefixed stdin.' }] } },
  ]);

  const hookPath = path.join(__dirname, 'session-start-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: `\uFEFF${JSON.stringify({ cwd: 'e:/VSCodeSpace/play/codex-continuity', session_id: '00000000-0000-0000-0000-000000000399' })}`,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /^Prior session context for this project:/);
  assert.match(output.hookSpecificOutput.additionalContext, /- title: Prior startup context/);
});

test('user prompt submit hook accepts BOM-prefixed JSON input', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const previousThreadId = '00000000-0000-0000-0000-000000000411';

  writeJsonl(codexHome, 'session_index.jsonl', [
    { id: previousThreadId, thread_name: 'Prior prompt context', updated_at: '2026-07-06T16:00:00Z' },
  ]);
  writeJsonl(codexHome, 'history.jsonl', [
    { session_id: previousThreadId, ts: 1783354200, text: 'prior prompt context should still parse with BOM input' },
  ]);
  writeJsonl(codexHome, 'sessions/2026/07/06/prompt-bom.jsonl', [
    { type: 'session_meta', id: previousThreadId, cwd: 'e:/VSCodeSpace/play/codex-continuity' },
    { type: 'response_item', item: { content: [{ type: 'output_text', text: 'Prior prompt context survives BOM-prefixed stdin.' }] } },
  ]);

  const hookPath = path.join(__dirname, 'user-prompt-submit-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: `\uFEFF${JSON.stringify({ cwd: 'e:/VSCodeSpace/play/codex-continuity', session_id: '00000000-0000-0000-0000-000000000499', prompt: 'prompt context with bom' })}`,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /- title: Prior prompt context/);
});

test('user prompt submit hook fails open on invalid input', () => {
  const hookPath = path.join(__dirname, 'user-prompt-submit-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: '{invalid json',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput, undefined);
});

test('stop hook settles the final assistant message into an ad-hoc note', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
  const hookPath = path.join(__dirname, 'stop-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: '00000000-0000-0000-0000-000000000555',
      cwd: 'e:/VSCodeSpace/play/codex-continuity',
      last_assistant_message: 'Fixed Stop hook capture for sidecar/stop-hook.js and hooks/hooks.json.',
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);

  const notesDir = path.join(codexHome, 'memories', 'extensions', 'ad_hoc', 'notes');
  const noteFiles = fs.readdirSync(notesDir);
  assert.equal(noteFiles.length, 1);
  const note = fs.readFileSync(path.join(notesDir, noteFiles[0]), 'utf8');
  assert.match(note, /Fixed Stop hook capture/);
  assert.match(note, /sidecar\/stop-hook\.js/);
  assert.match(note, /hooks\/hooks\.json/);
});

test('stop hook fails open on invalid input', () => {
  const hookPath = path.join(__dirname, 'stop-hook.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: '{invalid json',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
});

test('codexContinuityCoreMemoryUpdateDraft and Apply update core memory with hash protection', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  const original = '# Memory Summary\n\nOld project summary.\n';
  writeFile(memoriesRoot, 'memory_summary.md', original);

  const runtime = createRuntime({ memoriesRoot });
  const draft = codexContinuityCoreMemoryUpdateDraft(runtime, {
    path: 'memory_summary.md',
    updatedContent: '# Memory Summary\n\nUpdated project summary with corrected continuity guidance.\n',
  });

  assert.equal(draft.action, 'review_update_core_memory');
  assert.equal(draft.targetPath, 'memory_summary.md');
  assert.match(draft.updatedContent, /corrected continuity guidance/);
  assert.equal(fs.readFileSync(path.join(memoriesRoot, 'memory_summary.md'), 'utf8'), original);

  const applied = codexContinuityCoreMemoryUpdateApply(runtime, {
    path: 'memory_summary.md',
    updatedContent: draft.updatedContent,
    expectedHash: draft.expectedHash,
  });

  assert.equal(applied.action, 'updated_core_memory');
  assert.notEqual(applied.currentHash, applied.previousHash);
  assert.match(fs.readFileSync(path.join(memoriesRoot, 'memory_summary.md'), 'utf8'), /corrected continuity guidance/);
});

test('codexContinuityCoreMemoryUpdateApply rejects unsupported paths and stale drafts', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(memoriesRoot, 'MEMORY.md', '# Memory\n\nOriginal memory.\n');

  const runtime = createRuntime({ memoriesRoot });
  const draft = codexContinuityCoreMemoryUpdateDraft(runtime, {
    path: 'MEMORY.md',
    updatedContent: '# Memory\n\nReviewed update.\n',
  });

  assert.throws(
    () => codexContinuityCoreMemoryUpdateDraft(runtime, {
      path: 'extensions/ad_hoc/notes/not-core.md',
      updatedContent: '# Not core\n',
    }),
    /MEMORY\.md or memory_summary\.md/,
  );

  fs.writeFileSync(path.join(memoriesRoot, 'MEMORY.md'), '# Memory\n\nChanged elsewhere.\n', 'utf8');
  assert.throws(
    () => codexContinuityCoreMemoryUpdateApply(runtime, {
      path: 'MEMORY.md',
      updatedContent: draft.updatedContent,
      expectedHash: draft.expectedHash,
    }),
    /Core memory changed since draft was created/,
  );
});

test('codexContinuityNoteUpdateDraft and Apply update an ad-hoc note with hash protection', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  const notePath = 'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md';
  const original = '# Fix login token refresh\n\n- project: demo\n\n## What happened\nFixed login token refresh for expired cookies.\n';
  writeFile(memoriesRoot, notePath, original);

  const runtime = createRuntime({ memoriesRoot });
  const draft = codexContinuityNoteUpdateDraft(runtime, {
    path: notePath,
    heading: 'Update: stale retry handling',
    timestamp: '2026-07-06T18:30:00.000Z',
    content: 'Added stale session retry handling and kept token refresh behavior unchanged.',
  });

  assert.equal(draft.action, 'review_update_existing_note');
  assert.equal(draft.targetPath, notePath);
  assert.match(draft.deltaSection, /## Update: stale retry handling/);
  assert.match(draft.updatedContent, /Fixed login token refresh/);
  assert.match(draft.updatedContent, /Added stale session retry handling/);
  assert.equal(fs.readFileSync(path.join(memoriesRoot, notePath), 'utf8'), original);

  const applied = codexContinuityNoteUpdateApply(runtime, {
    path: notePath,
    updatedContent: draft.updatedContent,
    expectedHash: draft.expectedHash,
  });

  const updated = fs.readFileSync(path.join(memoriesRoot, notePath), 'utf8');
  assert.equal(applied.action, 'updated_existing_note');
  assert.notEqual(applied.currentHash, applied.previousHash);
  assert.match(updated, /Update: stale retry handling/);
  assert.match(updated, /Added stale session retry handling/);
});

test('codexContinuityNoteUpdateApply rejects stale update drafts', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  const notePath = 'extensions/ad_hoc/notes/2026-07-06T10-00-00-login-fix.md';
  writeFile(memoriesRoot, notePath, '# Fix login\n\nOriginal note.\n');

  const runtime = createRuntime({ memoriesRoot });
  const draft = codexContinuityNoteUpdateDraft(runtime, {
    path: notePath,
    content: 'Reviewed update.',
  });
  fs.writeFileSync(path.join(memoriesRoot, notePath), '# Fix login\n\nChanged elsewhere.\n', 'utf8');

  assert.throws(
    () => codexContinuityNoteUpdateApply(runtime, {
      path: notePath,
      updatedContent: draft.updatedContent,
      expectedHash: draft.expectedHash,
    }),
    /Existing note changed since draft was created/,
  );
test('codexContinuitySessionNoteDraft builds a capture note draft, overlap recommendation, and core-memory promotion draft', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(memoriesRoot, 'memory_summary.md', '# Memory Summary\n\nExisting project summary.\n');
  writeFile(
    memoriesRoot,
    'extensions/ad_hoc/notes/2026-07-06T12-00-00-session-note-drafting.md',
    '# Fix session note drafting\n\n- project: codex-continuity\n- session: old session note draft\n\n## What happened\nAdded session note draft orchestration for sidecar/session.js.\n\n## Files changed\n- `sidecar/session.js`: added draft orchestration\n',
  );

  const runtime = createRuntime({ memoriesRoot });
  const draft = codexContinuitySessionNoteDraft(runtime, {
    digest: {
      threadId: '00000000-0000-0000-0000-000000000def',
      title: 'Fix session note drafting',
      project: 'codex-continuity',
      cwd: 'e:/VSCodeSpace/play/codex-continuity',
      summary: 'Added session note draft orchestration and overlap checks.',
      relatedPaths: ['sidecar/session.js', 'sidecar/tools.js'],
      rolloutPaths: ['sessions/2026/07/06/note-draft.jsonl'],
    },
    type: 'feature',
  });

  assert.match(draft.slug, /fix-session-note-drafting/);
  assert.match(draft.content, /# Fix session note drafting/);
  assert.match(draft.content, /thread `00000000-0000-0000-0000-000000000def`/);
  assert.match(draft.content, /sidecar\/session\.js/);
  assert.equal(draft.overlap.recommendation.action, 'update_existing');
  assert.equal(draft.settling.action, 'write_delta_note');
  assert.equal(draft.settling.targetPath, 'extensions/ad_hoc/notes/2026-07-06T12-00-00-session-note-drafting.md');
  assert.equal(draft.coreMemoryPromotion.targetPath, 'memory_summary.md');
  assert.equal(draft.coreMemoryPromotion.action, 'review_update_core_memory');
  assert.match(draft.coreMemoryPromotion.draft.updatedContent, /Session continuity update/);
  assert.match(draft.coreMemoryPromotion.draft.updatedContent, /Added session note draft orchestration and overlap checks\./);
});

test('codexContinuitySettleAdHocNote returns a core-memory promotion draft for stable outcomes', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(memoriesRoot, 'memory_summary.md', '# Memory Summary\n\nExisting project summary.\n');

  const runtime = createRuntime({ memoriesRoot });
  const settled = codexContinuitySettleAdHocNote(runtime, {
    title: 'Fix stop hook capture',
    type: 'bugfix',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    paths: ['sidecar/stop-hook.js', 'hooks/hooks.json'],
    content: 'Fixed Stop hook capture for sidecar/stop-hook.js and hooks/hooks.json so final session outcomes settle reliably.',
    timestamp: '2026-07-07T12:45:00.000Z',
  });

  assert.equal(settled.action, 'created_ad_hoc_note');
  assert.equal(settled.coreMemoryPromotion.targetPath, 'memory_summary.md');
  assert.equal(settled.coreMemoryPromotion.action, 'review_update_core_memory');
  assert.match(settled.coreMemoryPromotion.draft.updatedContent, /Fix stop hook capture/);
  assert.match(settled.coreMemoryPromotion.draft.updatedContent, /sidecar\/stop-hook\.js/);
});

  assert.equal(draft.coreMemoryPromotion.targetPath, 'memory_summary.md');
  assert.equal(draft.coreMemoryPromotion.action, 'review_update_core_memory');
  assert.match(draft.coreMemoryPromotion.draft.updatedContent, /Session continuity update/);
  assert.match(draft.coreMemoryPromotion.draft.updatedContent, /Added session note draft orchestration and overlap checks\./);
});

test('codexContinuitySettleAdHocNote returns a core-memory promotion draft for stable outcomes', () => {
  const memoriesRoot = makeTempMemoriesRoot();
  writeFile(memoriesRoot, 'memory_summary.md', '# Memory Summary\n\nExisting project summary.\n');

  const runtime = createRuntime({ memoriesRoot });
  const settled = codexContinuitySettleAdHocNote(runtime, {
    title: 'Fix stop hook capture',
    type: 'bugfix',
    cwd: 'e:/VSCodeSpace/play/codex-continuity',
    paths: ['sidecar/stop-hook.js', 'hooks/hooks.json'],
    content: 'Fixed Stop hook capture for sidecar/stop-hook.js and hooks/hooks.json so final session outcomes settle reliably.',
    timestamp: '2026-07-07T12:45:00.000Z',
  });

  assert.equal(settled.action, 'created_ad_hoc_note');
  assert.equal(settled.coreMemoryPromotion.targetPath, 'memory_summary.md');
  assert.equal(settled.coreMemoryPromotion.action, 'review_update_core_memory');
  assert.match(settled.coreMemoryPromotion.draft.updatedContent, /Fix stop hook capture/);
  assert.match(settled.coreMemoryPromotion.draft.updatedContent, /sidecar\/stop-hook\.js/);
});
