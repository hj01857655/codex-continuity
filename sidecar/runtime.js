const path = require('path');
const os = require('os');

const DEFAULT_MEMORIES_ROOT = path.join(os.homedir(), '.codex', 'memories');
const INDEX_FILENAME = 'codex-continuity-index.json';
const INDEX_VERSION = 1;
const PROTOCOL_VERSION = '2025-03-26';

const SERVER_INFO = {
  name: 'codex-continuity-mcp',
  title: 'Codex Continuity Retrieval',
  version: '1.1.0',
};

const NOTE_TYPES = {
  MEMORY: 'memory_index',
  SUMMARY: 'summary',
  RAW: 'raw_memory',
  AD_HOC: 'ad_hoc_note',
  ROLLOUT: 'rollout_summary',
  OTHER: 'other',
};

function createRuntime(options = {}) {
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const memoriesRoot = path.resolve(options.memoriesRoot || process.env.CODEX_MEMORIES_ROOT || path.join(codexHome, 'memories'));
  return {
    codexHome,
    memoriesRoot,
    indexPath: path.join(memoriesRoot, INDEX_FILENAME),
  };
}

module.exports = {
  DEFAULT_MEMORIES_ROOT,
  INDEX_FILENAME,
  INDEX_VERSION,
  NOTE_TYPES,
  PROTOCOL_VERSION,
  SERVER_INFO,
  createRuntime,
};
