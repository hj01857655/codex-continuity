const fs = require('fs');

const { createRuntime } = require('./runtime');
const { codexContinuityRawArchive, codexContinuityWriteHealthSnapshot } = require('./session');
const { codexContinuityWriteAdHocNote } = require('./tools');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookInput(raw) {
  const normalized = String(raw || '').replace(/^\uFEFF/, '').trim();
  return normalized ? JSON.parse(normalized) : {};
}

function success() {
  return {
    continue: true,
    suppressOutput: true,
  };
}

function readTranscriptTail(transcriptPath, maxChars = 12000) {
  const filePath = String(transcriptPath || '').trim();
  if (!filePath) {
    return '';
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return '';
  }
}

function archiveRawRollouts(runtime) {
  try {
    codexContinuityRawArchive(runtime, { limit: 10000 });
    codexContinuityWriteHealthSnapshot(runtime, { eventName: 'PreCompact' });
  } catch {
    // Fail open: continuity backup must never block compaction.
  }
}

function buildPreCompactNote(input) {
  const sessionId = String(input.session_id || input.sessionId || '').trim();
  if (!sessionId) {
    return null;
  }

  const transcriptTail = readTranscriptTail(input.transcript_path || input.transcriptPath);
  const trigger = String(input.trigger || '').trim();
  const cwd = String(input.cwd || '').trim();
  const metadata = [
    `- session: ${sessionId}`,
    input.turn_id || input.turnId ? `- turn: ${input.turn_id || input.turnId}` : null,
    cwd ? `- cwd: ${cwd}` : null,
    trigger ? `- trigger: ${trigger}` : null,
    '- type: pre-compact-checkpoint',
  ].filter(Boolean).join('\n');
  const content = [
    '# Pre-compact Codex checkpoint',
    '',
    metadata,
    '',
    '## What happened',
    'Codex was about to compact this session. The original transcript/rollout remains the full-fidelity source; this note preserves a stage checkpoint for stock Codex memory consolidation.',
    transcriptTail ? `\n## Transcript tail before compact\n${transcriptTail}` : null,
  ].filter(Boolean).join('\n');

  return {
    title: 'Pre-compact Codex checkpoint',
    slug: 'pre-compact-codex-checkpoint',
    cwd,
    content,
  };
}

async function main() {
  try {
    const input = parseHookInput(readStdin());
    const note = buildPreCompactNote(input);
    if (note) {
      const runtime = createRuntime();
      archiveRawRollouts(runtime);
      codexContinuityWriteAdHocNote(runtime, note);
    }
    process.stdout.write(JSON.stringify(success()) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(success()) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  archiveRawRollouts,
  buildPreCompactNote,
  parseHookInput,
  readTranscriptTail,
  success,
};
