function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function basenameFromAnyPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1]?.toLowerCase() || '';
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function pathSignalTokens(value) {
  const normalized = normalizeText(String(value || '').replace(/\\/g, '/'));
  const parts = normalized.split('/').filter(Boolean);
  const suffixes = parts.map((_, index) => parts.slice(index).join('/'));
  return uniq([...parts, ...suffixes]);
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9_./\-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function firstNonEmptyLine(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] || '';
}

function limitText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function daysAgo(mtimeMs) {
  if (!mtimeMs) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86400000));
}

function makeSnippet(content, tokens) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return '';
  }

  const loweredTokens = tokens.map((token) => token.toLowerCase());
  const matchedLine = lines.find((line) => {
    const lower = line.toLowerCase();
    return loweredTokens.some((token) => lower.includes(token));
  });

  const source = matchedLine || lines.slice(0, 3).join(' ');
  return limitText(source, 280);
}

function extractStructuredPaths(content) {
  const paths = [];
  const regexes = [
    /`([^`]+\.[a-z0-9]+)`/gi,
    /-\s+`([^`]+)`\s*:/gi,
    /\b([a-z0-9_./-]+\.[a-z0-9]{1,8})\b/gi,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(content))) {
      const candidate = match[1].replace(/\\/g, '/');
      if (candidate.length <= 160 && candidate.includes('/')) {
        paths.push(candidate);
      }
    }
  }

  return uniq(paths);
}

function extractTaggedField(content, fieldName) {
  const values = [];
  const lines = content.split(/\r?\n/);
  const matcher = new RegExp(`^\\s*-\\s*${fieldName}\\s*:\\s*(.+)$`, 'i');
  for (const line of lines) {
    const match = line.match(matcher);
    if (match) {
      values.push(match[1].trim());
    }
  }
  return uniq(values);
}

function extractProjectHints(content) {
  return extractTaggedField(content, 'project');
}

function extractSessionHints(content) {
  return extractTaggedField(content, 'session');
}

function extractHeadings(content) {
  return uniq(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .filter(Boolean),
  );
}

function computeContentSignature(content) {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

module.exports = {
  basenameFromAnyPath,
  computeContentSignature,
  daysAgo,
  extractHeadings,
  extractProjectHints,
  extractSessionHints,
  extractStructuredPaths,
  firstNonEmptyLine,
  limitText,
  makeSnippet,
  normalizeText,
  pathSignalTokens,
  tokenize,
  uniq,
};
