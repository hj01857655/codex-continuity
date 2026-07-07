const fs = require('fs');
const path = require('path');

const { createRuntime } = require('./runtime');
const { codexContinuitySessionContext, codexContinuityWriteHookHealthMarker } = require('./session');

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

function writeHookHealthMarker(runtime) {
  try {
    codexContinuityWriteHookHealthMarker(runtime, { eventName: 'SessionStart' });
  } catch {
    // Fail open: observability must never block Codex startup.
  }
}

function queryFromInput(input) {
  const cwd = String(input.cwd || '').trim();
  return cwd ? path.basename(cwd.replace(/\\/g, '/')) : '';
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
    writeHookHealthMarker(runtime);
    const context = codexContinuitySessionContext(runtime, {
      query,
      cwd,
      limit: 2,
      exclude_thread_id: sessionId,
      context_mode: 'hook',
      include_rollouts: false,
      require_cwd_match: true,
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
  writeHookHealthMarker,
  formatDigestBlock,
  formatSessionContext,
  parseHookInput,
  queryFromInput,
  success,
};

