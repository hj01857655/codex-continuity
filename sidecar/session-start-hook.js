const fs = require('fs');
const path = require('path');

const { createRuntime } = require('./runtime');
const { codexContinuitySessionContext } = require('./session');

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

function formatSessionContext(context) {
  if (!context.hasContext || !context.digests.length) {
    return '';
  }

  const sections = context.digests.slice(0, 2).map((digest, index) => {
    const paths = (digest.relatedPaths || []).slice(0, 6).map((item) => `- ${item}`).join('\n') || '- No related paths identified.';
    const sources = (digest.sources || []).join(', ') || 'unknown';
    return [
      `## Prior Codex Session ${index + 1}: ${digest.title || digest.threadId}`,
      digest.threadId ? `- thread: ${digest.threadId}` : null,
      digest.cwd ? `- cwd: ${digest.cwd}` : null,
      `- sources: ${sources}`,
      '',
      digest.summary || 'No focused summary available.',
      '',
      'Related paths:',
      paths,
    ].filter((line) => line != null).join('\n');
  });

  return `Relevant prior Codex session context for this project:\n\n${sections.join('\n\n')}`;
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
    const context = codexContinuitySessionContext(runtime, {
      query,
      cwd,
      limit: 2,
      exclude_thread_id: sessionId,
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
  formatSessionContext,
  parseHookInput,
  queryFromInput,
  success,
};

