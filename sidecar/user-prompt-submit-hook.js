const fs = require('fs');

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
      hookEventName: 'UserPromptSubmit',
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

function writeHookHealthMarker(runtime) {
  try {
    codexContinuityWriteHookHealthMarker(runtime, { eventName: 'UserPromptSubmit' });
  } catch {
    // Fail open: observability must never block prompt submission.
  }
}

function formatSessionContext(context) {
  if (!context.hasContext || !context.digests.length) {
    return '';
  }

  const sections = context.digests.slice(0, 2).map(formatDigestBlock);
  return `Prior session context for this prompt:\n\n${sections.join('\n\n')}`;
}

async function main() {
  try {
    const input = parseHookInput(readStdin());
    const sessionId = input.session_id || input.sessionId;
    const cwd = String(input.cwd || '').trim();
    const prompt = String(input.prompt || '').trim();
    if (!prompt) {
      process.stdout.write(JSON.stringify(success(null)) + '\n');
      return;
    }

    const runtime = createRuntime();
    writeHookHealthMarker(runtime);
    const context = codexContinuitySessionContext(runtime, {
      query: prompt,
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
  success,
};
