const fs = require('fs');

const { createRuntime } = require('./runtime');
const { codexContinuityRawArchive } = require('./session');

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

function archiveRawRollouts(runtime) {
  try {
    codexContinuityRawArchive(runtime, { limit: 10000 });
  } catch {
    // Fail open: continuity backup must never block compaction completion.
  }
}

async function main() {
  try {
    parseHookInput(readStdin());
    archiveRawRollouts(createRuntime());
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
  parseHookInput,
  success,
};
