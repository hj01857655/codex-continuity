const fs = require('fs');
const path = require('path');

const { createRuntime } = require('./runtime');
const { codexContinuityRawArchive, codexContinuitySessionContext } = require('./session');

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

function success(additionalContext) {
  const output = {
    continue: true,
    suppressOutput: true,
  };

  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext,
    };
  }

  return output;
}

function formatDigestBlock(digest) {
  const paths = (digest.relatedPaths || []).slice(0, 4).join(', ') || 'none';
  return [
    `- title: ${digest.title || digest.threadId || 'unknown'}`,
    digest.summary ? `- summary: ${digest.summary}` : null,
    `- related_paths: ${paths}`,
  ].filter(Boolean).join('\n');
}

function formatSessionContext(context) {
  if (!context.hasContext || !context.digests.length) {
    return '';
  }

  const sections = context.digests.slice(0, 2).map(formatDigestBlock);
  return `Prior session context for this project:\n\n${sections.join('\n\n')}`;
}

function archiveRawRollouts(runtime) {
  try {
    codexContinuityRawArchive(runtime, { limit: 10000 });
  } catch {
    // Fail open: continuity backup must never block Codex startup.
  }
}

function queryFromInput(input) {
  const cwd = String(input.cwd || '').trim();
  const project = cwd ? path.basename(cwd.replace(/\\/g, '/')) : '';
  return [project, 'recent decisions root cause session context'].filter(Boolean).join(' ');
}

async function main() {
  try {
    const input = parseHookInput(readStdin());
    const sessionId = input.session_id || input.sessionId;
    const cwd = String(input.cwd || '').trim();
    const query = queryFromInput(input);
    if (!query) {
      process.stdout.write(JSON.stringify(success(null)) + '\n');
      return;
    }

    const runtime = createRuntime();
    archiveRawRollouts(runtime);
    const context = codexContinuitySessionContext(runtime, {
      query,
      cwd,
      limit: 2,
      exclude_thread_id: sessionId,
      context_mode: 'hook',
    });
    process.stdout.write(JSON.stringify(success(formatSessionContext(context))) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(success(null)) + '\n');
  }
}

if (require.main === module) {
  main();
}
module.exports = {
  archiveRawRollouts,
  formatDigestBlock,
  formatSessionContext,
  parseHookInput,
  queryFromInput,
  success,
};

