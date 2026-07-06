const { basenameFromAnyPath, makeSnippet, normalizeText, pathSignalTokens, tokenize, uniq } = require('./text');
const { buildIndex } = require('./index');
const { getTokenSet, intersectionSize, scoreDocument } = require('./scoring');

function findOverlapHits(index, args = {}) {
  const content = String(args.content || '').trim();
  const cwd = String(args.cwd || '').trim();
  const paths = uniq((args.paths || []).map((value) => String(value).replace(/\\/g, '/')));
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20));
  const inputTokens = uniq([
    ...tokenize(content),
    ...paths.flatMap(tokenize),
  ]);
  const inputTokenSet = getTokenSet(inputTokens);
  const normalizedPaths = paths.map(normalizeText);
  const cwdToken = cwd ? basenameFromAnyPath(cwd) : '';
  const cwdPathTokens = pathSignalTokens(cwd).filter((token) => token !== cwdToken);

  return index.documents
    .map((doc) => {
      const docTokenSet = getTokenSet(doc.contentTokens);
      const tokenOverlap = intersectionSize(inputTokenSet, docTokenSet);
      const pathOverlap = normalizedPaths.reduce((count, item) => {
        return count + (doc.structuredPaths.some((value) => normalizeText(value).includes(item)) ? 1 : 0);
      }, 0);
      const projectOverlap = cwdToken && doc.projectHints.some((value) => normalizeText(value).includes(cwdToken)) ? 1 : 0;
      const overlapScore = tokenOverlap * 3
        + pathOverlap * 12
        + projectOverlap * 8
        + scoreDocument(doc, inputTokens, cwdToken, cwdPathTokens, normalizedPaths);

      return {
        path: doc.relativePath,
        type: doc.type,
        title: doc.title,
        overlapScore,
        tokenOverlap,
        pathOverlap,
        projectOverlap,
        snippet: makeSnippet(doc.content, inputTokens),
        relatedPaths: doc.structuredPaths.slice(0, 12),
      };
    })
    .filter((hit) => hit.overlapScore > 0)
    .sort((a, b) => b.overlapScore - a.overlapScore)
    .slice(0, limit);
}

function buildOverlapRecommendation(hits) {
  const primaryMatch = hits[0] || null;
  if (!primaryMatch) {
    return {
      action: 'create_new',
      confidence: 'low',
      reason: 'no_similar_memory_found',
      primaryMatch: null,
    };
  }

  if (primaryMatch.overlapScore >= 75) {
    return {
      action: 'update_existing',
      confidence: 'high',
      reason: 'high_confidence_overlap',
      primaryMatch,
    };
  }

  if (primaryMatch.overlapScore >= 40) {
    return {
      action: 'review_existing',
      confidence: 'medium',
      reason: 'partial_overlap_detected',
      primaryMatch,
    };
  }

  return {
    action: 'create_new',
    confidence: 'low',
    reason: 'overlap_not_strong_enough',
    primaryMatch,
  };
}

function codexContinuityOverlap(runtime, args) {
  const content = String(args?.content || '').trim();
  if (!content) {
    throw new Error('`content` is required');
  }

  const hits = findOverlapHits(buildIndex(runtime), args);
  return {
    cwd: String(args?.cwd || '').trim() || null,
    paths: uniq((args?.paths || []).map((value) => String(value).replace(/\\/g, '/'))),
    recommendation: buildOverlapRecommendation(hits),
    hits,
  };
}

module.exports = {
  buildOverlapRecommendation,
  findOverlapHits,
  codexContinuityOverlap,
};
