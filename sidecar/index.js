const path = require('path');

const { INDEX_VERSION, NOTE_TYPES, createRuntime } = require('./runtime');
const {
  collectMemoryFiles,
  relativeMemoryPath,
  safeRead,
  safeReadJson,
  safeStat,
  safeWriteJson,
} = require('./files');
const {
  computeContentSignature,
  daysAgo,
  extractHeadings,
  extractProjectHints,
  extractSessionHints,
  extractStructuredPaths,
  firstNonEmptyLine,
  tokenize,
  uniq,
} = require('./text');

function detectNoteType(relativePath) {
  if (relativePath === 'MEMORY.md') return NOTE_TYPES.MEMORY;
  if (relativePath === 'memory_summary.md') return NOTE_TYPES.SUMMARY;
  if (relativePath === 'raw_memories.md') return NOTE_TYPES.RAW;
  if (relativePath.startsWith('extensions/ad_hoc/notes/')) return NOTE_TYPES.AD_HOC;
  if (relativePath.startsWith('rollout_summaries/')) return NOTE_TYPES.ROLLOUT;
  return NOTE_TYPES.OTHER;
}

function createFileManifest(runtime, filePath) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) {
    return null;
  }

  return {
    path: relativeMemoryPath(runtime, filePath),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function buildManifest(runtime) {
  return collectMemoryFiles(runtime)
    .map((filePath) => createFileManifest(runtime, filePath))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function manifestsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => {
    const other = right[index];
    return other && entry.path === other.path && entry.mtimeMs === other.mtimeMs && entry.size === other.size;
  });
}

function buildDocument(runtime, filePath) {
  const stat = safeStat(filePath);
  const content = safeRead(filePath);
  const relativePath = relativeMemoryPath(runtime, filePath);
  const type = detectNoteType(relativePath);
  const structuredPaths = extractStructuredPaths(content);
  const projectHints = extractProjectHints(content);
  const sessionHints = extractSessionHints(content);
  const headings = extractHeadings(content);
  const ageDays = daysAgo(stat?.mtimeMs || 0);
  const pathTokens = tokenize(relativePath);
  const contentTokens = uniq([
    ...tokenize(content),
    ...projectHints.flatMap(tokenize),
    ...sessionHints.flatMap(tokenize),
    ...structuredPaths.flatMap(tokenize),
    ...headings.flatMap(tokenize),
  ]);

  return {
    path: filePath,
    relativePath,
    type,
    content,
    title: firstNonEmptyLine(content),
    headings,
    projectHints,
    sessionHints,
    structuredPaths,
    mtimeMs: stat?.mtimeMs || 0,
    ageDays,
    pathTokens,
    contentTokens,
    contentSignature: computeContentSignature(content),
  };
}

function buildDocuments(runtime, manifest) {
  return manifest.map((entry) => buildDocument(runtime, path.join(runtime.memoriesRoot, entry.path)));
}

function readPersistedIndex(runtime) {
  const persisted = safeReadJson(runtime.indexPath);
  if (!persisted || persisted.version !== INDEX_VERSION) {
    return null;
  }
  if (!Array.isArray(persisted.manifest) || !Array.isArray(persisted.documents)) {
    return null;
  }
  return persisted;
}

function serializeIndex(runtime, manifest, documents) {
  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    indexPath: runtime.indexPath,
    memoriesRoot: runtime.memoriesRoot,
    manifest,
    documents,
  };
}

function buildIndex(runtimeInput = {}) {
  const runtime = runtimeInput.memoriesRoot ? createRuntime(runtimeInput) : runtimeInput;
  const manifest = buildManifest(runtime);
  const persisted = readPersistedIndex(runtime);

  if (persisted && manifestsEqual(manifest, persisted.manifest)) {
    return {
      ...persisted,
      meta: {
        reused: true,
        rebuilt: false,
        indexPath: runtime.indexPath,
      },
    };
  }

  const documents = buildDocuments(runtime, manifest);
  const serialized = serializeIndex(runtime, manifest, documents);
  safeWriteJson(runtime.indexPath, serialized);

  return {
    ...serialized,
    meta: {
      reused: false,
      rebuilt: true,
      indexPath: runtime.indexPath,
    },
  };
}

module.exports = {
  buildDocument,
  buildIndex,
  buildManifest,
  detectNoteType,
};
