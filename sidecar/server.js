const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const memoriesRoot = path.join(os.homedir(), '.codex', 'memories');
const protocolVersion = '2025-03-26';
const serverInfo = {
  name: 'codex-memory-mcp',
  title: 'Codex Memory Retrieval',
  version: '1.0.0',
};

const NOTE_TYPES = {
  MEMORY: 'memory_index',
  SUMMARY: 'summary',
  RAW: 'raw_memory',
  AD_HOC: 'ad_hoc_note',
  ROLLOUT: 'rollout_summary',
  OTHER: 'other',
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function listMarkdownFiles(dirPath) {
  if (!safeStat(dirPath)?.isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectMemoryFiles() {
  const roots = [
    path.join(memoriesRoot, 'MEMORY.md'),
    path.join(memoriesRoot, 'memory_summary.md'),
    path.join(memoriesRoot, 'raw_memories.md'),
  ];

  const collected = [];
  for (const filePath of roots) {
    if (safeStat(filePath)?.isFile()) {
      collected.push(filePath);
    }
  }

  collected.push(...listMarkdownFiles(path.join(memoriesRoot, 'extensions', 'ad_hoc', 'notes')));
  collected.push(...listMarkdownFiles(path.join(memoriesRoot, 'rollout_summaries')));

  const seen = new Set();
  return collected.filter((filePath) => {
    const normalized = path.normalize(filePath).toLowerCase();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9_./\\-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function relativeMemoryPath(filePath) {
  return path.relative(memoriesRoot, filePath).replace(/\\/g, '/');
}

function firstNonEmptyLine(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] || '';
}

function limitText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function detectNoteType(relativePath) {
  if (relativePath === 'MEMORY.md') {
    return NOTE_TYPES.MEMORY;
  }
  if (relativePath === 'memory_summary.md') {
    return NOTE_TYPES.SUMMARY;
  }
  if (relativePath === 'raw_memories.md') {
    return NOTE_TYPES.RAW;
  }
  if (relativePath.startsWith('extensions/ad_hoc/notes/')) {
    return NOTE_TYPES.AD_HOC;
  }
  if (relativePath.startsWith('rollout_summaries/')) {
    return NOTE_TYPES.ROLLOUT;
  }
  return NOTE_TYPES.OTHER;
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

function extractProjectHints(content) {
  const projects = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s*project\s*:\s*(.+)$/i);
    if (match) {
      projects.push(match[1].trim());
    }
  }
  return uniq(projects);
}

function extractSessionHints(content) {
  const sessions = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s*session\s*:\s*(.+)$/i);
    if (match) {
      sessions.push(match[1].trim());
    }
  }
  return uniq(sessions);
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

function buildDocument(filePath) {
  const stat = safeStat(filePath);
  const content = safeRead(filePath);
  const relativePath = relativeMemoryPath(filePath);
  const type = detectNoteType(relativePath);
  const structuredPaths = extractStructuredPaths(content);
  const projectHints = extractProjectHints(content);
  const sessionHints = extractSessionHints(content);
  const headings = extractHeadings(content);
  const ageDays = daysAgo(stat?.mtimeMs || 0);

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
  };
}

function loadDocuments() {
  return collectMemoryFiles().map(buildDocument);
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

function scoreDocument(doc, queryTokens, cwdToken, pathFilters) {
  let score = 0;
  const pathText = normalizeText(doc.relativePath);
  const contentText = normalizeText(doc.content);
  const titleText = normalizeText(doc.title);
  const headingText = normalizeText(doc.headings.join(' '));
  const projectText = normalizeText(doc.projectHints.join(' '));
  const sessionText = normalizeText(doc.sessionHints.join(' '));
  const structuredPaths = doc.structuredPaths.map(normalizeText);

  for (const token of queryTokens) {
    if (titleText.includes(token)) score += 10;
    if (headingText.includes(token)) score += 8;
    if (pathText.includes(token)) score += 8;
    if (structuredPaths.some((item) => item.includes(token))) score += 7;
    if (projectText.includes(token)) score += 7;
    if (sessionText.includes(token)) score += 5;
    if (contentText.includes(token)) score += 4;
  }

  if (cwdToken) {
    if (projectText.includes(cwdToken)) score += 16;
    if (sessionText.includes(cwdToken)) score += 10;
    if (pathText.includes(cwdToken)) score += 8;
    if (contentText.includes(cwdToken)) score += 5;
  }

  for (const pathFilter of pathFilters || []) {
    if (pathText.includes(pathFilter)) score += 15;
    if (structuredPaths.some((item) => item.includes(pathFilter))) score += 14;
    if (contentText.includes(pathFilter)) score += 6;
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

function queryDocuments(args = {}) {
  const query = String(args.query || '').trim();
  const cwd = String(args.cwd || '').trim();
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 50));
  const types = uniq((args.types || []).map(String)).map(normalizeText);
  const pathFilters = uniq((args.paths || []).map((item) => String(item).replace(/\\/g, '/')))
    .map(normalizeText);
  const recentDays = Number(args.recent_days);

  const queryTokens = tokenize(query);
  const cwdToken = cwd ? path.basename(cwd).toLowerCase() : '';
  const documents = loadDocuments();

  const hits = documents
    .filter((doc) => matchesType(doc, types))
    .filter((doc) => matchesPathFilter(doc, pathFilters))
    .filter((doc) => matchesRecentDays(doc, recentDays))
    .map((doc) => ({ doc, score: scoreDocument(doc, queryTokens, cwdToken, pathFilters) }))
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
    totalFilesScanned: documents.length,
    hitCount: hits.length,
    hits,
  };
}

function memoryCaptureSearch(args) {
  const query = String(args?.query || '').trim();
  if (!query) {
    throw new Error('`query` is required');
  }
  return queryDocuments(args);
}

function memoryCaptureProjectSummary(args) {
  const cwd = String(args?.cwd || '').trim();
  if (!cwd) {
    throw new Error('`cwd` is required');
  }

  const repoName = path.basename(cwd);
  const broadSummary = queryDocuments({
    query: repoName || 'recent memory',
    cwd,
    limit: 10,
    types: [NOTE_TYPES.MEMORY, NOTE_TYPES.SUMMARY, NOTE_TYPES.AD_HOC, NOTE_TYPES.ROLLOUT],
  });

  const summaryLines = broadSummary.hits.slice(0, 6).map((hit) => {
    const title = hit.title ? `${hit.title} — ` : '';
    return `- ${hit.path}: ${title}${hit.snippet}`;
  });

  return {
    cwd,
    repoName,
    summary: summaryLines.length
      ? summaryLines.join('\n')
      : 'No strongly related project memory found in the current memories workspace.',
    supportingHits: broadSummary.hits,
  };
}

function memoryCaptureRelatedFiles(args) {
  const paths = uniq((args?.paths || []).map((value) => String(value).replace(/\\/g, '/')));
  if (!paths.length) {
    throw new Error('`paths` must contain at least one path');
  }

  const result = queryDocuments({
    query: paths.join(' '),
    cwd: String(args?.cwd || '').trim(),
    limit: Math.max(1, Math.min(Number(args?.limit) || 10, 30)),
    paths,
  });

  return {
    inputPaths: paths,
    cwd: result.cwd,
    hitCount: result.hitCount,
    hits: result.hits,
  };
}

function memoryCaptureRecentDecisions(args) {
  const cwd = String(args?.cwd || '').trim();
  const query = String(args?.query || 'decision root cause choice rejected alternative').trim();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 8, 20));

  return queryDocuments({
    query,
    cwd,
    limit,
    types: [NOTE_TYPES.AD_HOC, NOTE_TYPES.MEMORY, NOTE_TYPES.SUMMARY],
    recent_days: Number(args?.recent_days) || 90,
  });
}

function memoryCaptureReadNote(args) {
  const notePath = String(args?.path || '').trim().replace(/\\/g, '/');
  if (!notePath) {
    throw new Error('`path` is required');
  }

  const fullPath = path.join(memoriesRoot, notePath);
  const stat = safeStat(fullPath);
  if (!stat?.isFile()) {
    throw new Error(`Note not found: ${notePath}`);
  }

  const doc = buildDocument(fullPath);
  return {
    path: doc.relativePath,
    type: doc.type,
    title: doc.title,
    headings: doc.headings,
    projects: doc.projectHints,
    relatedPaths: doc.structuredPaths,
    ageDays: doc.ageDays,
    content: doc.content,
  };
}

function memoryCaptureIndexStatus() {
  const files = collectMemoryFiles();
  const documents = files.map(buildDocument);
  const latestMtimeMs = documents.reduce((max, doc) => Math.max(max, doc.mtimeMs), 0);
  const typeCounts = documents.reduce((acc, doc) => {
    acc[doc.type] = (acc[doc.type] || 0) + 1;
    return acc;
  }, {});

  return {
    memoriesRoot,
    fileCount: documents.length,
    latestUpdateIso: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
    typeCounts,
    sources: {
      memorySummary: safeStat(path.join(memoriesRoot, 'memory_summary.md'))?.isFile() || false,
      memoryIndex: safeStat(path.join(memoriesRoot, 'MEMORY.md'))?.isFile() || false,
      rawMemories: safeStat(path.join(memoriesRoot, 'raw_memories.md'))?.isFile() || false,
      adHocNotes: safeStat(path.join(memoriesRoot, 'extensions', 'ad_hoc', 'notes'))?.isDirectory() || false,
      rolloutSummaries: safeStat(path.join(memoriesRoot, 'rollout_summaries'))?.isDirectory() || false,
    },
  };
}

const tools = {
  memory_capture_index_status: {
    description: 'Report the current memories workspace coverage, file counts, and source availability.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: memoryCaptureIndexStatus,
  },
  memory_capture_search: {
    description: 'Search the Codex memories workspace by query, type filters, path filters, and recency.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Bug, feature, path, or decision terms.' },
        cwd: { type: 'string', description: 'Optional current repo or cwd path.' },
        limit: { type: 'number', description: 'Max hits to return (1-50).' },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional note types: memory_index, summary, raw_memory, ad_hoc_note, rollout_summary, other.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file or module path filters.',
        },
        recent_days: { type: 'number', description: 'Optional recency filter in days.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: memoryCaptureSearch,
  },
  memory_capture_project_summary: {
    description: 'Generate a project-oriented summary using the current repo or cwd as a memory anchor.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Current repo or cwd path.' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    run: memoryCaptureProjectSummary,
  },
  memory_capture_related_files: {
    description: 'Find memory notes and summaries related to one or more file paths or modules.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative or absolute file/module paths to correlate against memory.',
        },
        cwd: { type: 'string', description: 'Optional current repo or cwd path.' },
        limit: { type: 'number', description: 'Max hits to return (1-30).' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    run: memoryCaptureRelatedFiles,
  },
  memory_capture_recent_decisions: {
    description: 'Surface recent decisions, root causes, and rejected alternatives from memory.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional current repo or cwd path.' },
        query: { type: 'string', description: 'Optional domain-specific decision terms.' },
        limit: { type: 'number', description: 'Max hits to return (1-20).' },
        recent_days: { type: 'number', description: 'Optional recency filter, defaults to 90 days.' },
      },
      additionalProperties: false,
    },
    run: memoryCaptureRecentDecisions,
  },
  memory_capture_read_note: {
    description: 'Read one memory artifact by path from the memories workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path under ~/.codex/memories/.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: memoryCaptureReadNote,
  },
};

function toolResultPayload(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
    isError: false,
  };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    return;
  }

  const { id, method, params } = message;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      serverInfo,
    });
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {
      tools: Object.entries(tools).map(([name, spec]) => ({
        name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const tool = tools[toolName];
    if (!tool) {
      sendError(id, -32602, `Unknown tool: ${toolName}`);
      return;
    }

    try {
      const result = tool.run(params?.arguments || {});
      sendResult(id, toolResultPayload(result));
    } catch (error) {
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: String(error && error.message ? error.message : error),
          },
        ],
        isError: true,
      });
    }
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    const message = JSON.parse(trimmed);
    await handleMessage(message);
  } catch (error) {
    sendError(null, -32700, 'Parse error', {
      detail: String(error && error.message ? error.message : error),
    });
  }
});