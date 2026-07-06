const { NOTE_TYPES } = require('./runtime');
const {
  basenameFromAnyPath,
  makeSnippet,
  normalizeText,
  pathSignalTokens,
  tokenize,
  uniq,
} = require('./text');

function getTokenSet(values) {
  return new Set(values.filter(Boolean));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function matchesType(doc, types) {
  return !types?.length || types.includes(doc.type);
}

function matchesPathFilter(doc, pathFilters) {
  if (!pathFilters?.length) {
    return true;
  }

  const haystacks = [doc.relativePath, ...doc.structuredPaths].map(normalizeText);
  return pathFilters.some((filter) => haystacks.some((value) => value.includes(filter)));
}

function matchesRecentDays(doc, recentDays) {
  if (!Number.isFinite(recentDays) || recentDays <= 0 || doc.ageDays === null) {
    return true;
  }
  return doc.ageDays <= recentDays;
}

function scoreDocument(doc, queryTokens, cwdToken, cwdPathTokens, pathFilters) {
  let score = 0;
  const pathText = normalizeText(doc.relativePath);
  const titleText = normalizeText(doc.title);
  const headingText = normalizeText(doc.headings.join(' '));
  const projectText = normalizeText(doc.projectHints.join(' '));
  const sessionText = normalizeText(doc.sessionHints.join(' '));
  const structuredPaths = doc.structuredPaths.map(normalizeText);
  const tokenSet = getTokenSet(doc.contentTokens);
  const projectTokenSet = getTokenSet(doc.projectHints.flatMap(tokenize));

  for (const token of queryTokens) {
    if (titleText.includes(token)) score += 12;
    if (headingText.includes(token)) score += 9;
    if (pathText.includes(token)) score += 8;
    if (structuredPaths.some((item) => item.includes(token))) score += 8;
    if (projectText.includes(token)) score += 7;
    if (sessionText.includes(token)) score += 6;
    if (tokenSet.has(token)) score += 4;
  }

  if (cwdToken) {
    if (projectText.includes(cwdToken)) score += 18;
    if (sessionText.includes(cwdToken)) score += 10;
    if (pathText.includes(cwdToken)) score += 8;
    if (tokenSet.has(cwdToken)) score += 5;
  }

  for (const token of cwdPathTokens || []) {
    if (projectTokenSet.has(token)) score += 9;
    if (projectText.includes(token)) score += 4;
  }

  for (const pathFilter of pathFilters || []) {
    if (pathText.includes(pathFilter)) score += 16;
    if (structuredPaths.some((item) => item.includes(pathFilter))) score += 16;
    if (tokenSet.has(pathFilter)) score += 5;
  }

  if (doc.type === NOTE_TYPES.AD_HOC) score += 3;
  if (doc.type === NOTE_TYPES.MEMORY) score += 2;
  if (doc.type === NOTE_TYPES.SUMMARY) score += 1;
  if (doc.ageDays !== null) score += Math.max(0, 7 - Math.min(doc.ageDays, 7));

  return score;
}

function serializeHit(doc, score, queryTokens) {
  return {
    path: doc.relativePath,
    type: doc.type,
    title: doc.title,
    score,
    ageDays: doc.ageDays,
    projects: doc.projectHints,
    relatedPaths: doc.structuredPaths.slice(0, 12),
    snippet: makeSnippet(doc.content, queryTokens),
  };
}

function queryDocuments(index, args = {}) {
  const query = String(args.query || '').trim();
  const cwd = String(args.cwd || '').trim();
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 50));
  const types = uniq((args.types || []).map(String)).map(normalizeText);
  const pathFilters = uniq((args.paths || []).map((item) => String(item).replace(/\\/g, '/')))
    .map(normalizeText);
  const recentDays = Number(args.recent_days);
  const queryTokens = uniq([
    ...tokenize(query),
    ...pathFilters.flatMap(tokenize),
  ]);
  const cwdToken = cwd ? basenameFromAnyPath(cwd) : '';
  const cwdPathTokens = pathSignalTokens(cwd).filter((token) => token !== cwdToken);

  const hits = index.documents
    .filter((doc) => matchesType(doc, types))
    .filter((doc) => matchesPathFilter(doc, pathFilters))
    .filter((doc) => matchesRecentDays(doc, recentDays))
    .map((doc) => ({ doc, score: scoreDocument(doc, queryTokens, cwdToken, cwdPathTokens, pathFilters) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.doc.mtimeMs - a.doc.mtimeMs)
    .slice(0, limit)
    .map(({ doc, score }) => serializeHit(doc, score, queryTokens));

  return {
    query: query || null,
    cwd: cwd || null,
    filters: {
      types,
      paths: pathFilters,
      recent_days: Number.isFinite(recentDays) ? recentDays : null,
    },
    totalFilesScanned: index.documents.length,
    hitCount: hits.length,
    hits,
  };
}

module.exports = {
  getTokenSet,
  intersectionSize,
  queryDocuments,
  scoreDocument,
};
