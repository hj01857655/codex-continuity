const fs = require('fs');
const path = require('path');

const { basenameFromAnyPath, makeSnippet, normalizeText, pathSignalTokens, tokenize, uniq } = require('./text');
const { safeRead, safeStat } = require('./files');

function listJsonlFiles(dirPath) {
  if (!safeStat(dirPath)?.isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

function readJsonl(filePath) {
  return safeRead(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureSession(sessions, threadId) {
  if (!threadId) {
    return null;
  }
  const id = String(threadId);
  if (!sessions.has(id)) {
    sessions.set(id, {
      threadId: id,
      name: null,
      cwd: null,
      updatedAt: null,
      historyTexts: [],
      rolloutTexts: [],
      rolloutPaths: [],
      sources: new Set(),
    });
  }
  return sessions.get(id);
}

function collectText(value, output = []) {
  if (value == null) {
    return output;
  }
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, output);
    }
    return output;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'message', 'summary']) {
      collectText(value[key], output);
    }
    for (const key of ['item', 'items', 'msg', 'record']) {
      collectText(value[key], output);
    }
  }
  return output;
}

function ingestSessionIndex(runtime, sessions) {
  const filePath = path.join(runtime.codexHome, 'session_index.jsonl');
  for (const entry of readJsonl(filePath)) {
    const session = ensureSession(sessions, entry.id || entry.thread_id || entry.threadId);
    if (!session) continue;
    session.name = entry.thread_name || entry.threadName || session.name;
    session.updatedAt = entry.updated_at || entry.updatedAt || session.updatedAt;
    session.sources.add('session_index');
  }
}

function ingestHistory(runtime, sessions) {
  const filePath = path.join(runtime.codexHome, 'history.jsonl');
  for (const entry of readJsonl(filePath)) {
    const session = ensureSession(sessions, entry.session_id || entry.sessionId || entry.thread_id || entry.threadId);
    if (!session) continue;
    if (entry.text) {
      session.historyTexts.push(String(entry.text));
    }
    session.updatedAt = entry.ts || session.updatedAt;
    session.sources.add('history');
  }
}

function ingestRollouts(runtime, sessions) {
  const roots = [path.join(runtime.codexHome, 'sessions'), path.join(runtime.codexHome, 'archived_sessions')];
  for (const root of roots) {
    for (const filePath of listJsonlFiles(root)) {
      const records = readJsonl(filePath);
      let threadId = null;
      let cwd = null;
      const texts = [];
      for (const record of records) {
        threadId = threadId || record.id || record.thread_id || record.threadId || record.session_id || record.sessionId;
        cwd = cwd || record.cwd || record.metadata?.cwd || record.meta?.cwd;
        collectText(record, texts);
      }
      const session = ensureSession(sessions, threadId);
      if (!session) continue;
      session.cwd = cwd || session.cwd;
      session.rolloutTexts.push(...texts);
      session.rolloutPaths.push(path.relative(runtime.codexHome, filePath).replace(/\\/g, '/'));
      session.sources.add('rollout');
    }
  }
}

function sessionScore(session, queryTokens, cwdTokens) {
  const nameText = normalizeText(session.name || '');
  const cwdText = normalizeText(session.cwd || '');
  const text = normalizeText([session.name, session.cwd, ...session.historyTexts, ...session.rolloutTexts].join(' '));
  let score = 0;
  for (const token of queryTokens) {
    if (nameText.includes(token)) score += 12;
    if (cwdText.includes(token)) score += 10;
    if (text.includes(token)) score += 4;
  }
  for (const token of cwdTokens) {
    if (cwdText.includes(token)) score += 8;
  }
  if (session.sources.has('rollout')) score += 4;
  if (session.sources.has('history')) score += 2;
  if (session.sources.has('session_index')) score += 2;
  return score;
}

function serializeSessionDigest(session, query) {
  const queryTokens = uniq(tokenize(String(query || session.name || '').trim()));
  const texts = [...session.rolloutTexts, ...session.historyTexts];
  const combined = texts.join('\n');
  return {
    threadId: session.threadId,
    title: session.name || session.threadId,
    project: sessionProjectName(session),
    cwd: session.cwd,
    sources: [...session.sources].sort(),
    rolloutPaths: session.rolloutPaths,
    summary: makeSnippet(combined, queryTokens),
    relatedPaths: extractRelatedPathsFromTexts(texts),
  };
}

function serializeHookContextDigest(digest) {
  return {
    threadId: digest.threadId,
    title: digest.title,
    summary: digest.summary,
    relatedPaths: digest.relatedPaths,
  };
}

function serializeSessionHit(session, score, queryTokens, options = {}) {
  const combined = [session.name, session.cwd, ...session.historyTexts, ...session.rolloutTexts].filter(Boolean).join('\n');
  const hit = {
    threadId: session.threadId,
    name: session.name,
    cwd: session.cwd,
    score,
    sources: [...session.sources].sort(),
    rolloutPaths: session.rolloutPaths,
    snippet: makeSnippet(combined, queryTokens),
  };
  if (options.includeDigest) {
    hit.digest = serializeSessionDigest(session, options.query);
  }
  return hit;
}

function collectSessions(runtime) {
  const sessions = new Map();
  ingestSessionIndex(runtime, sessions);
  ingestHistory(runtime, sessions);
  ingestRollouts(runtime, sessions);
  return sessions;
}

function rolloutRoots(runtime) {
  return [
    { root: path.join(runtime.codexHome, 'sessions'), archived: false, rootName: 'sessions' },
    { root: path.join(runtime.codexHome, 'archived_sessions'), archived: true, rootName: 'archived_sessions' },
  ];
}

function parseJsonlFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const records = [];
    const errors = [];
    raw.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        records.push(JSON.parse(trimmed));
      } catch (error) {
        errors.push({ line: index + 1, message: String(error.message || error) });
      }
    });
    return { readable: true, records, errors, raw };
  } catch (error) {
    return { readable: false, records: [], errors: [{ line: null, message: String(error.message || error) }], raw: '' };
  }
}

function sessionIdentityFromRecords(records) {
  let threadId = null;
  let cwd = null;
  for (const record of records) {
    threadId = threadId || record.id || record.thread_id || record.threadId || record.session_id || record.sessionId || record.meta?.id || record.metadata?.id;
    cwd = cwd || record.cwd || record.metadata?.cwd || record.meta?.cwd;
  }
  return {
    threadId: threadId ? String(threadId) : null,
    cwd: cwd ? String(cwd) : null,
  };
}

function relativeCodexPath(runtime, filePath) {
  return path.relative(runtime.codexHome, filePath).replace(/\\/g, '/');
}

function rolloutInventoryEntries(runtime) {
  const entries = [];
  for (const { root, archived, rootName } of rolloutRoots(runtime)) {
    for (const filePath of listJsonlFiles(root)) {
      const stat = safeStat(filePath);
      const parsed = parseJsonlFile(filePath);
      const identity = sessionIdentityFromRecords(parsed.records);
      entries.push({
        threadId: identity.threadId,
        path: relativeCodexPath(runtime, filePath),
        absolutePath: filePath,
        root: rootName,
        archived,
        cwd: identity.cwd,
        updatedAt: stat?.mtime ? stat.mtime.toISOString() : null,
        sizeBytes: stat?.size || 0,
        readable: parsed.readable,
        parseable: parsed.readable && parsed.errors.length === 0 && parsed.records.length > 0,
        recordCount: parsed.records.length,
        parseErrors: parsed.errors,
      });
    }
  }
  return entries.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function codexContinuitySessionInventory(runtime, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, 1000));
  const includeAbsolutePaths = args.include_absolute_paths === true || args.includeAbsolutePaths === true;
  const entries = rolloutInventoryEntries(runtime).slice(0, limit).map((entry) => {
    const item = { ...entry };
    if (!includeAbsolutePaths) {
      delete item.absolutePath;
    }
    return item;
  });
  const counts = entries.reduce((acc, entry) => {
    acc.total += 1;
    acc[entry.archived ? 'archived' : 'active'] += 1;
    if (!entry.readable) acc.unreadable += 1;
    if (!entry.parseable) acc.malformed += 1;
    return acc;
  }, { total: 0, active: 0, archived: 0, unreadable: 0, malformed: 0 });

  return {
    codexHome: runtime.codexHome,
    roots: {
      active: 'sessions',
      archived: 'archived_sessions',
    },
    counts,
    entries,
  };
}

function sessionIndexIds(runtime) {
  const ids = new Set();
  for (const entry of readJsonl(path.join(runtime.codexHome, 'session_index.jsonl'))) {
    const id = entry.id || entry.thread_id || entry.threadId;
    if (id) ids.add(String(id));
  }
  return ids;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values.filter(Boolean)) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function newestFile(files) {
  return files
    .map((filePath) => ({ filePath, stat: safeStat(filePath) }))
    .filter((entry) => entry.stat?.isFile())
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0] || null;
}

function pluginRuntimeInfo(runtime) {
  const pluginRoot = path.resolve(__dirname, '..');
  const manifest = readJsonFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  const serverEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const normalizedServer = String(serverEntrypoint || '').replace(/\\/g, '/').toLowerCase();
  const source = normalizedServer.includes('/plugins/cache/')
    ? 'plugin-cache'
    : normalizedServer.includes('/codex-continuity/')
      ? 'source-or-global-launcher'
      : 'unknown';

  return {
    pluginVersion: manifest?.version || null,
    pluginRoot,
    serverEntrypoint,
    source,
    codexHome: runtime.codexHome,
    memoriesRoot: runtime.memoriesRoot,
  };
}

function archiveObservability(runtime) {
  const root = archiveRoot(runtime);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = readJsonFile(manifestPath);
  const latestArchive = newestFile(listJsonlFiles(root));
  return {
    archiveRoot: path.relative(runtime.codexHome, root).replace(/\\/g, '/'),
    manifestPath: safeStat(manifestPath)?.isFile() ? path.relative(runtime.codexHome, manifestPath).replace(/\\/g, '/') : null,
    lastArchivedAt: manifest?.archivedAt || null,
    lastArchiveCounts: manifest?.counts || null,
    latestArchivedFile: latestArchive ? {
      path: path.relative(runtime.codexHome, latestArchive.filePath).replace(/\\/g, '/'),
      updatedAt: latestArchive.stat.mtime.toISOString(),
      sizeBytes: latestArchive.stat.size,
    } : null,
  };
}

function checkpointObservability(runtime) {
  const notesDir = path.join(runtime.memoriesRoot, 'extensions', 'ad_hoc', 'notes');
  const files = safeStat(notesDir)?.isDirectory()
    ? fs.readdirSync(notesDir)
      .filter((name) => name.endsWith('.md') && name.includes('pre-compact-codex-checkpoint'))
      .map((name) => path.join(notesDir, name))
    : [];
  const latest = newestFile(files);
  return {
    notesDir: path.relative(runtime.memoriesRoot, notesDir).replace(/\\/g, '/'),
    latestPreCompactCheckpoint: latest ? {
      path: path.relative(runtime.memoriesRoot, latest.filePath).replace(/\\/g, '/'),
      updatedAt: latest.stat.mtime.toISOString(),
      sizeBytes: latest.stat.size,
    } : null,
  };
}

function codexContinuitySessionHealth(runtime, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  const entries = rolloutInventoryEntries(runtime);
  const indexIds = sessionIndexIds(runtime);
  const duplicateThreadIds = duplicateValues(entries.map((entry) => entry.threadId));
  const unreadable = entries.filter((entry) => !entry.readable);
  const malformed = entries.filter((entry) => entry.readable && !entry.parseable);
  const missingSessionIndex = entries.filter((entry) => entry.threadId && !indexIds.has(entry.threadId));
  const indexedWithoutRollout = [...indexIds].filter((id) => !entries.some((entry) => entry.threadId === id)).sort();
  const issues = [];

  if (unreadable.length) issues.push({ type: 'unreadable_rollout', count: unreadable.length, samples: unreadable.slice(0, limit).map((entry) => entry.path) });
  if (malformed.length) issues.push({ type: 'malformed_rollout', count: malformed.length, samples: malformed.slice(0, limit).map((entry) => entry.path) });
  if (duplicateThreadIds.length) issues.push({ type: 'duplicate_thread_id', count: duplicateThreadIds.length, samples: duplicateThreadIds.slice(0, limit) });
  if (missingSessionIndex.length) issues.push({ type: 'missing_session_index_entry', count: missingSessionIndex.length, samples: missingSessionIndex.slice(0, limit).map((entry) => ({ threadId: entry.threadId, path: entry.path })) });
  if (indexedWithoutRollout.length) issues.push({ type: 'session_index_without_rollout', count: indexedWithoutRollout.length, samples: indexedWithoutRollout.slice(0, limit) });

  const archive = archiveObservability(runtime);
  if (!archive.lastArchivedAt && entries.length) {
    issues.push({ type: 'raw_archive_missing', count: 1, samples: ['codex-continuity/raw_archive/manifest.json'] });
  }

  return {
    status: issues.length ? 'warning' : 'ok',
    checkedAt: new Date().toISOString(),
    runtime: pluginRuntimeInfo(runtime),
    observability: {
      archive,
      checkpoint: checkpointObservability(runtime),
    },
    counts: {
      total: entries.length,
      active: entries.filter((entry) => !entry.archived).length,
      archived: entries.filter((entry) => entry.archived).length,
      unreadable: unreadable.length,
      malformed: malformed.length,
      duplicateThreadIds: duplicateThreadIds.length,
      missingSessionIndex: missingSessionIndex.length,
      indexedWithoutRollout: indexedWithoutRollout.length,
      rawArchiveMissing: archive.lastArchivedAt || !entries.length ? 0 : 1,
    },
    issues,
  };
}

function archiveRoot(runtime) {
  return path.join(runtime.codexHome, 'codex-continuity', 'raw_archive');
}

function copyIfChanged(source, target) {
  const sourceBytes = fs.readFileSync(source);
  const existing = safeStat(target)?.isFile() ? fs.readFileSync(target) : null;
  if (existing && Buffer.compare(sourceBytes, existing) === 0) {
    return 'unchanged';
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sourceBytes);
  return existing ? 'updated' : 'created';
}

function codexContinuityWriteHealthSnapshot(runtime, args = {}) {
  const snapshot = {
    ...codexContinuitySessionHealth(runtime, args),
    eventName: args.eventName || args.event_name || null,
    writtenAt: new Date().toISOString(),
  };
  const target = path.join(runtime.codexHome, 'codex-continuity', 'health.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

function codexContinuityRawArchive(runtime, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 1000, 10000));
  const entries = rolloutInventoryEntries(runtime).slice(0, limit);
  const root = archiveRoot(runtime);
  const archivedAt = new Date().toISOString();
  const files = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const entry of entries) {
    const target = path.join(root, entry.path);
    try {
      const action = copyIfChanged(entry.absolutePath, target);
      if (action === 'created') created += 1;
      if (action === 'updated') updated += 1;
      if (action === 'unchanged') unchanged += 1;
      files.push({
        threadId: entry.threadId,
        sourcePath: entry.path,
        archivePath: path.relative(runtime.codexHome, target).replace(/\\/g, '/'),
        archived: entry.archived,
        action,
      });
    } catch (error) {
      failed += 1;
      files.push({
        threadId: entry.threadId,
        sourcePath: entry.path,
        archived: entry.archived,
        action: 'failed',
        error: String(error.message || error),
      });
    }
  }

  const manifest = {
    archivedAt,
    codexHome: runtime.codexHome,
    archiveRoot: path.relative(runtime.codexHome, root).replace(/\\/g, '/'),
    counts: { scanned: entries.length, created, updated, unchanged, failed },
    files,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}

function arrayFromOptional(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function codexContinuitySessionSearch(runtime, args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    throw new Error('`query` is required');
  }
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 50));
  const cwd = String(args.cwd || '').trim();
  const includeDigest = args.include_digest === true || args.includeDigest === true;
  const excludedThreadIds = new Set(
    [
      args.exclude_thread_id,
      args.excludeThreadId,
      ...arrayFromOptional(args.exclude_thread_ids),
      ...arrayFromOptional(args.excludeThreadIds),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const queryTokens = uniq(tokenize(query));
  const cwdToken = cwd ? basenameFromAnyPath(cwd) : '';
  const cwdTokens = pathSignalTokens(cwd).filter((token) => token !== cwdToken);
  const sessions = collectSessions(runtime);

  const hits = [...sessions.values()]
    .filter((session) => !excludedThreadIds.has(session.threadId))
    .map((session) => ({ session, score: sessionScore(session, queryTokens, cwdTokens) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ session, score }) => serializeSessionHit(session, score, queryTokens, { includeDigest, query }));

  return {
    query,
    cwd: cwd || null,
    hitCount: hits.length,
    hits,
  };
}

function codexContinuitySessionContext(runtime, args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    throw new Error('`query` is required');
  }

  const contextMode = String(args.context_mode || args.contextMode || '').trim();
  const result = codexContinuitySessionSearch(runtime, {
    ...args,
    query,
    include_digest: true,
  });
  const hits = result.hits.filter((hit) => hit.digest);
  const digests = hits.map((hit) => (
    contextMode === 'hook'
      ? serializeHookContextDigest(hit.digest)
      : hit.digest
  ));

  return {
    query: result.query,
    cwd: result.cwd,
    hasContext: digests.length > 0,
    primary: hits[0] || null,
    hitCount: hits.length,
    hits,
    digests,
  };
}

function extractRelatedPathsFromTexts(texts) {
  const paths = [];
  const pattern = /\b([a-z0-9_./-]+\.[a-z0-9]{1,8})\b/gi;
  for (const text of texts) {
    let match;
    while ((match = pattern.exec(text))) {
      const candidate = match[1].replace(/\\/g, '/');
      if (candidate.includes('/') && candidate.length <= 160) {
        paths.push(candidate);
      }
    }
  }
  return uniq(paths);
}

function sessionProjectName(session) {
  if (!session.cwd) {
    return null;
  }
  return basenameFromAnyPath(session.cwd);
}

function codexContinuitySessionDigest(runtime, args = {}) {
  const threadId = String(args.thread_id || args.threadId || '').trim();
  if (!threadId) {
    throw new Error('`thread_id` is required');
  }

  const session = collectSessions(runtime).get(threadId);
  if (!session) {
    throw new Error(`Session not found: ${threadId}`);
  }

  return serializeSessionDigest(session, args.query);
}

module.exports = {
  codexContinuityWriteHealthSnapshot,
  codexContinuityRawArchive,
  codexContinuitySessionHealth,
  codexContinuitySessionInventory,
  codexContinuitySessionContext,
  codexContinuitySessionDigest,
  codexContinuitySessionSearch,
  serializeHookContextDigest,
};
