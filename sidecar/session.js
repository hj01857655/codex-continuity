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
  codexContinuitySessionContext,
  codexContinuitySessionDigest,
  codexContinuitySessionSearch,
  serializeHookContextDigest,
};
