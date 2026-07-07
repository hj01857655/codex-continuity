const fs = require('fs');

const { createRuntime } = require('./runtime');
const { codexContinuityRawArchive } = require('./session');
const { codexContinuitySettleAdHocNote } = require('./tools');

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function parseHookInput(raw) {
  const normalized = String(raw || '').replace(/^\uFEFF/, '').trim();
  return normalized ? JSON.parse(normalized) : {};
}

function success(systemMessage) {
  const output = {
    continue: true,
    suppressOutput: true,
  };

  if (systemMessage) {
    output.systemMessage = systemMessage;
  }

  return output;
}

function extractRelatedPaths(text) {
  const paths = [];
  const pattern = /\b([a-z0-9_./-]+\.[a-z0-9]{1,8})\b/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const candidate = match[1].replace(/\\/g, '/');
    if (candidate.includes('/') && candidate.length <= 160 && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  }
  return paths;
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
  } catch {
    // Fail open: continuity backup must never block stop handling.
  }
}

function firstMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, '').replace(/^[-*]\s*/, ''))
    .find(Boolean) || 'Codex session outcome';
}

function buildStopNote(input) {
  const lastAssistantMessage = String(input.last_assistant_message || input.lastAssistantMessage || '').trim();
  const transcriptTail = readTranscriptTail(input.transcript_path || input.transcriptPath);
  if (!lastAssistantMessage && !transcriptTail) {
    return null;
  }

  const sessionId = String(input.session_id || input.sessionId || '').trim();
  const cwd = String(input.cwd || '').trim();
  const title = firstMeaningfulLine(lastAssistantMessage || transcriptTail).slice(0, 120);
  const sourceText = [lastAssistantMessage, transcriptTail].filter(Boolean).join('\n');
  const metadata = [
    sessionId ? `- session: ${sessionId}` : null,
    cwd ? `- cwd: ${cwd}` : null,
    transcriptTail ? '- source: transcript_path' : '- source: last_assistant_message',
    '- type: stop-hook',
  ].filter(Boolean).join('\n');
  const paths = extractRelatedPaths(sourceText);
  const pathLines = paths.length
    ? paths.map((item) => `- \`${item}\``).join('\n')
    : '- No specific files identified.';
  const transcriptSection = transcriptTail
    ? `\n## Transcript tail\n${transcriptTail}\n`
    : '';

  return {
    title,
    cwd,
    paths,
    heading: 'Stop hook update',
    content: `# ${title}\n\n${metadata}\n\n## What happened\n${lastAssistantMessage || 'No final assistant message was provided.'}${transcriptSection}\n## Files changed\n${pathLines}\n\n## Source session\nDerived from Codex Stop hook${sessionId ? ` for session \`${sessionId}\`` : ''}. The transcript/rollout remains the full-fidelity source.\n`,
  };
}

function buildPromotionMessage(settled) {
  const promotion = settled?.coreMemoryPromotion || null;
  if (!promotion?.targetPath) {
    return null;
  }
  return `Core memory promotion draft ready for ${promotion.targetPath}. Review the proposed draft before applying it.`;
}

async function main() {
  try {
    const raw = await readStdin();
    const input = parseHookInput(raw);
    const runtime = createRuntime();
    archiveRawRollouts(runtime);
    const note = buildStopNote(input);
    let systemMessage = null;
    if (note) {
      const settled = codexContinuitySettleAdHocNote(runtime, note);
      systemMessage = buildPromotionMessage(settled);
    }
    process.stdout.write(JSON.stringify(success(systemMessage)) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(success(null)) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  archiveRawRollouts,
  buildPromotionMessage,
  buildStopNote,
  extractRelatedPaths,
  parseHookInput,
  readTranscriptTail,
  success,
};
