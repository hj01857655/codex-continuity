const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { NOTE_TYPES } = require('./runtime');
const { safeStat } = require('./files');
const { buildDocument, buildIndex } = require('./index');
const { queryDocuments } = require('./scoring');
const { codexContinuityOverlap } = require('./overlap');
const {
  codexContinuitySessionContext,
  codexContinuitySessionDigest,
  codexContinuitySessionSearch,
} = require('./session');
const { uniq } = require('./text');

function codexContinuitySearch(runtime, args) {
  const query = String(args?.query || '').trim();
  if (!query) {
    throw new Error('`query` is required');
  }
  return queryDocuments(buildIndex(runtime), args);
}

function codexContinuityProjectSummary(runtime, args) {
  const cwd = String(args?.cwd || '').trim();
  if (!cwd) {
    throw new Error('`cwd` is required');
  }

  const repoName = path.basename(cwd.replace(/\\/g, '/'));
  const broadSummary = queryDocuments(buildIndex(runtime), {
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

function codexContinuityRelatedFiles(runtime, args) {
  const paths = uniq((args?.paths || []).map((value) => String(value).replace(/\\/g, '/')));
  if (!paths.length) {
    throw new Error('`paths` must contain at least one path');
  }

  const result = queryDocuments(buildIndex(runtime), {
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

function codexContinuityRecentDecisions(runtime, args) {
  const cwd = String(args?.cwd || '').trim();
  const query = String(args?.query || 'decision root cause choice rejected alternative').trim();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 8, 20));

  return queryDocuments(buildIndex(runtime), {
    query,
    cwd,
    limit,
    types: [NOTE_TYPES.AD_HOC, NOTE_TYPES.MEMORY, NOTE_TYPES.SUMMARY],
    recent_days: Number(args?.recent_days) || 90,
  });
}

function slugify(value) {
  return String(value || 'session-memory')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session-memory';
}

function normalizePaths(paths) {
  return uniq((paths || []).map((value) => String(value).replace(/\\/g, '/')));
}

function buildSettlingRecommendation(overlap) {
  const recommendation = overlap.recommendation || {};
  const primaryMatch = recommendation.primaryMatch || null;
  if (recommendation.action === 'update_existing' && primaryMatch) {
    return {
      action: 'write_delta_note',
      confidence: recommendation.confidence || 'high',
      reason: 'high_overlap_with_existing_memory',
      targetPath: primaryMatch.path,
      guidance: 'Write a short delta/update note that references the existing memory instead of restating the full prior context.',
    };
  }
  if (recommendation.action === 'review_existing' && primaryMatch) {
    return {
      action: 'review_before_writing',
      confidence: recommendation.confidence || 'medium',
      reason: 'partial_overlap_with_existing_memory',
      targetPath: primaryMatch.path,
      guidance: 'Review the matched memory before writing; only capture the new decision, root cause, or changed outcome.',
    };
  }
  return {
    action: 'create_new_note',
    confidence: recommendation.confidence || 'low',
    reason: recommendation.reason || 'no_strong_overlap',
    targetPath: null,
    guidance: 'Create a new ad-hoc note from the draft content.',
  };
}

function codexContinuitySessionNoteDraft(runtime, args = {}) {
  const digest = args.digest || null;
  if (!digest || typeof digest !== 'object') {
    throw new Error('`digest` is required');
  }

  const title = String(digest.title || digest.threadId || 'Session memory').trim();
  const threadId = String(digest.threadId || digest.thread_id || '').trim();
  const project = String(digest.project || '').trim();
  const cwd = String(digest.cwd || args.cwd || '').trim();
  const summary = String(digest.summary || '').trim();
  const relatedPaths = normalizePaths(digest.relatedPaths || digest.related_paths || args.paths);
  const rolloutPaths = normalizePaths(digest.rolloutPaths || digest.rollout_paths);
  const noteType = String(args.type || 'session').trim();
  const slug = slugify(title);

  const pathLines = relatedPaths.length
    ? relatedPaths.map((item) => `- \`${item}\``).join('\n')
    : '- No specific files identified in the session digest.';
  const rolloutLines = rolloutPaths.length
    ? rolloutPaths.map((item) => `- \`${item}\``).join('\n')
    : '- No rollout paths recorded.';
  const metadata = [
    project ? `- project: ${project}` : null,
    threadId ? `- session: thread \`${threadId}\`` : null,
    cwd ? `- cwd: ${cwd}` : null,
    `- type: ${noteType}`,
  ].filter(Boolean).join('\n');

  const content = `# ${title}\n\n${metadata}\n\n## What happened\n${summary || 'Session digest did not include a focused summary.'}\n\n## Files changed\n${pathLines}\n\n## Source session\n${threadId ? `Derived from Codex thread \`${threadId}\`.` : 'Derived from a Codex session digest.'}\n\n## Rollout paths\n${rolloutLines}\n`;
  const overlap = codexContinuityOverlap(runtime, {
    content,
    paths: relatedPaths,
    cwd,
    limit: Number(args.limit) || 5,
  });
  const settling = buildSettlingRecommendation(overlap);

  return {
    slug,
    title,
    type: noteType,
    threadId: threadId || null,
    project: project || null,
    cwd: cwd || null,
    paths: relatedPaths,
    rolloutPaths,
    content,
    overlap,
    settling,
  };
}

function normalizeMemoryPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function assertAdHocNotePath(notePath) {
  if (!notePath || path.isAbsolute(notePath) || notePath.includes('..')) {
    throw new Error('`path` must be a relative ad-hoc note path');
  }
  if (!notePath.startsWith('extensions/ad_hoc/notes/') || !notePath.endsWith('.md')) {
    throw new Error('`path` must point to extensions/ad_hoc/notes/*.md');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertCoreMemoryPath(notePath) {
  if (!['MEMORY.md', 'memory_summary.md'].includes(notePath)) {
    throw new Error('`path` must be MEMORY.md or memory_summary.md');
  }
}

function codexContinuityCoreMemoryUpdateDraft(runtime, args = {}) {
  const targetPath = normalizeMemoryPath(args.path || args.target_path || args.targetPath);
  const updatedContent = String(args.updatedContent || args.updated_content || args.content || '').trimEnd();
  if (!targetPath) {
    throw new Error('`path` is required');
  }
  assertCoreMemoryPath(targetPath);
  if (!updatedContent) {
    throw new Error('`updatedContent` is required');
  }

  const existing = codexContinuityReadNote(runtime, { path: targetPath });
  const expectedHash = sha256(existing.content);
  return {
    targetPath,
    title: existing.title,
    action: 'review_update_core_memory',
    guidance: 'Review updatedContent, then call codex_continuity_core_memory_update_apply with targetPath, updatedContent, and expectedHash only when the core memory change is intentional.',
    expectedHash,
    updatedContent,
    existing,
  };
}

function codexContinuityCoreMemoryUpdateApply(runtime, args = {}) {
  const targetPath = normalizeMemoryPath(args.path || args.targetPath || args.target_path);
  const updatedContent = String(args.updatedContent || args.updated_content || '').trimEnd();
  const expectedHash = String(args.expectedHash || args.expected_hash || '').trim();
  if (!targetPath) {
    throw new Error('`path` is required');
  }
  assertCoreMemoryPath(targetPath);
  if (!updatedContent) {
    throw new Error('`updatedContent` is required');
  }
  if (!expectedHash) {
    throw new Error('`expectedHash` is required');
  }

  const fullPath = path.join(runtime.memoriesRoot, targetPath);
  if (!safeStat(fullPath)?.isFile()) {
    throw new Error(`Core memory file not found: ${targetPath}`);
  }

  const currentContent = fs.readFileSync(fullPath, 'utf8');
  const currentHash = sha256(currentContent);
  if (currentHash !== expectedHash) {
    throw new Error('Core memory changed since draft was created; rebuild the update draft before applying.');
  }

  const finalContent = updatedContent.endsWith('\n') ? updatedContent : `${updatedContent}\n`;
  fs.writeFileSync(fullPath, finalContent, 'utf8');
  return {
    targetPath,
    action: 'updated_core_memory',
    previousHash: currentHash,
    currentHash: sha256(finalContent),
  };
}

function codexContinuityNoteUpdateDraft(runtime, args = {}) {
  const targetPath = normalizeMemoryPath(args.path || args.target_path || args.targetPath);
  const content = String(args.content || args.note || args.delta || '').trim();
  if (!targetPath) {
    throw new Error('`path` is required');
  }
  assertAdHocNotePath(targetPath);
  if (!content) {
    throw new Error('`content` is required');
  }

  const existing = codexContinuityReadNote(runtime, { path: targetPath });
  const heading = String(args.heading || 'Update').trim() || 'Update';
  const timestamp = String(args.timestamp || new Date().toISOString()).trim();
  const deltaSection = `\n\n## ${heading}\n\n- updated_at: ${timestamp}\n\n${content}\n`;
  const updatedContent = `${existing.content.trimEnd()}${deltaSection}`;
  const expectedHash = sha256(existing.content);

  return {
    targetPath,
    title: existing.title,
    action: 'review_update_existing_note',
    guidance: 'Review updatedContent, then call codex_continuity_note_update_apply with targetPath, updatedContent, and expectedHash if the merge is accurate.',
    expectedHash,
    deltaSection: deltaSection.trimStart(),
    updatedContent,
    existing,
  };
}

function codexContinuityNoteUpdateApply(runtime, args = {}) {
  const targetPath = normalizeMemoryPath(args.path || args.targetPath || args.target_path);
  const updatedContent = String(args.updatedContent || args.updated_content || '').trimEnd();
  const expectedHash = String(args.expectedHash || args.expected_hash || '').trim();
  if (!targetPath) {
    throw new Error('`path` is required');
  }
  assertAdHocNotePath(targetPath);
  if (!updatedContent) {
    throw new Error('`updatedContent` is required');
  }
  if (!expectedHash) {
    throw new Error('`expectedHash` is required');
  }

  const fullPath = path.join(runtime.memoriesRoot, targetPath);
  if (!safeStat(fullPath)?.isFile()) {
    throw new Error(`Note not found: ${targetPath}`);
  }

  const currentContent = fs.readFileSync(fullPath, 'utf8');
  const currentHash = sha256(currentContent);
  if (currentHash !== expectedHash) {
    throw new Error('Existing note changed since draft was created; rebuild the update draft before applying.');
  }

  const finalContent = updatedContent.endsWith('\n') ? updatedContent : `${updatedContent}\n`;
  fs.writeFileSync(fullPath, finalContent, 'utf8');
  return {
    targetPath,
    action: 'updated_existing_note',
    previousHash: currentHash,
    currentHash: sha256(finalContent),
  };
}

function codexContinuityWriteAdHocNote(runtime, args = {}) {
  const title = String(args.title || 'Codex continuity note').trim();
  const content = String(args.content || '').trimEnd();
  if (!content) {
    throw new Error('`content` is required');
  }

  const timestamp = String(args.timestamp || new Date().toISOString()).trim();
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  const fileSlug = slugify(args.slug || title);
  const notesDir = path.join(runtime.memoriesRoot, 'extensions', 'ad_hoc', 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  let relativePath = `extensions/ad_hoc/notes/${safeTimestamp}-${fileSlug}.md`;
  let fullPath = path.join(runtime.memoriesRoot, relativePath);
  let counter = 2;
  while (safeStat(fullPath)?.isFile()) {
    relativePath = `extensions/ad_hoc/notes/${safeTimestamp}-${fileSlug}-${counter}.md`;
    fullPath = path.join(runtime.memoriesRoot, relativePath);
    counter += 1;
  }

  const finalContent = content.endsWith('\n') ? content : `${content}\n`;
  fs.writeFileSync(fullPath, finalContent, 'utf8');
  return {
    path: relativePath,
    action: 'created_ad_hoc_note',
    title,
    content: finalContent,
  };
}

function codexContinuitySettleAdHocNote(runtime, args = {}) {
  const title = String(args.title || 'Codex continuity note').trim();
  const content = String(args.content || '').trim();
  if (!content) {
    throw new Error('`content` is required');
  }
  const cwd = String(args.cwd || '').trim();
  const paths = normalizePaths(args.paths || []);
  const heading = String(args.heading || 'Update').trim() || 'Update';
  const timestamp = String(args.timestamp || new Date().toISOString()).trim();
  const overlap = codexContinuityOverlap(runtime, {
    content,
    cwd,
    paths,
    limit: Number(args.limit) || 5,
  });
  const recommendation = overlap.recommendation || {};
  const primaryMatch = recommendation.primaryMatch || null;

  if (recommendation.action === 'update_existing' && primaryMatch?.path?.startsWith('extensions/ad_hoc/notes/')) {
    const draft = codexContinuityNoteUpdateDraft(runtime, {
      path: primaryMatch.path,
      content,
      heading,
      timestamp,
    });
    const applied = codexContinuityNoteUpdateApply(runtime, {
      path: draft.targetPath,
      updatedContent: draft.updatedContent,
      expectedHash: draft.expectedHash,
    });
    return {
      action: 'updated_existing_note',
      overlap,
      draft,
      applied,
    };
  }

  const note = codexContinuityWriteAdHocNote(runtime, {
    title,
    content,
    slug: args.slug,
    timestamp,
  });
  return {
    action: 'created_ad_hoc_note',
    overlap,
    note,
  };
}

function codexContinuityReadNote(runtime, args) {
  const notePath = String(args?.path || '').trim().replace(/\\/g, '/');
  if (!notePath) {
    throw new Error('`path` is required');
  }

  const fullPath = path.join(runtime.memoriesRoot, notePath);
  if (!safeStat(fullPath)?.isFile()) {
    throw new Error(`Note not found: ${notePath}`);
  }

  const doc = buildDocument(runtime, fullPath);
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

function codexContinuityIndexStatus(runtime) {
  const index = buildIndex(runtime);
  const latestMtimeMs = index.documents.reduce((max, doc) => Math.max(max, doc.mtimeMs), 0);
  const typeCounts = index.documents.reduce((acc, doc) => {
    acc[doc.type] = (acc[doc.type] || 0) + 1;
    return acc;
  }, {});

  return {
    memoriesRoot: runtime.memoriesRoot,
    fileCount: index.documents.length,
    latestUpdateIso: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
    typeCounts,
    meta: index.meta,
    sources: {
      memorySummary: safeStat(path.join(runtime.memoriesRoot, 'memory_summary.md'))?.isFile() || false,
      memoryIndex: safeStat(path.join(runtime.memoriesRoot, 'MEMORY.md'))?.isFile() || false,
      rawMemories: safeStat(path.join(runtime.memoriesRoot, 'raw_memories.md'))?.isFile() || false,
      adHocNotes: safeStat(path.join(runtime.memoriesRoot, 'extensions', 'ad_hoc', 'notes'))?.isDirectory() || false,
      rolloutSummaries: safeStat(path.join(runtime.memoriesRoot, 'rollout_summaries'))?.isDirectory() || false,
    },
  };
}

function createToolRegistry(runtime) {
  return {
    codex_continuity_index_status: {
      description: 'Report the current memories workspace coverage, file counts, source availability, and index reuse status.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      run: () => codexContinuityIndexStatus(runtime),
    },
    codex_continuity_search: {
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
      run: (args) => codexContinuitySearch(runtime, args),
    },
    codex_continuity_project_summary: {
      description: 'Generate a project-oriented summary using the current repo or cwd as a memory anchor.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Current repo or cwd path.' },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityProjectSummary(runtime, args),
    },
    codex_continuity_related_files: {
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
      run: (args) => codexContinuityRelatedFiles(runtime, args),
    },
    codex_continuity_session_context: {
      description: 'Load the most relevant prior Codex session context for the current task, with hydrated digests.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Current task, bug, feature, or design terms.' },
          cwd: { type: 'string', description: 'Optional current repo or cwd path for project-aware ranking.' },
          limit: { type: 'number', description: 'Max prior session contexts to return (1-50).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args) => codexContinuitySessionContext(runtime, args),
    },
    codex_continuity_session_digest: {
      description: 'Compress one Codex session into a reusable memory digest by thread id.',
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: 'Codex thread/session id returned by codex_continuity_session_search.' },
          query: { type: 'string', description: 'Optional focus terms for choosing the most relevant digest snippet.' },
        },
        required: ['thread_id'],
        additionalProperties: false,
      },
      run: (args) => codexContinuitySessionDigest(runtime, args),
    },
    codex_continuity_session_search: {
      description: 'Search Codex sessions by combining session_index.jsonl, history.jsonl, and rollout JSONL content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Session name, user prompt, rollout content, bug text, or decision terms.' },
          cwd: { type: 'string', description: 'Optional current repo or cwd path for project-aware ranking.' },
          limit: { type: 'number', description: 'Max session hits to return (1-50).' },
          include_digest: { type: 'boolean', description: 'When true, include a reusable memory digest on each returned hit.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args) => codexContinuitySessionSearch(runtime, args),
    },
    codex_continuity_core_memory_update_draft: {
      description: 'Build a reviewable update draft for MEMORY.md or memory_summary.md without mutating it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Core memory file to update: MEMORY.md or memory_summary.md.' },
          updatedContent: { type: 'string', description: 'Full reviewed Markdown content proposed for the core memory file.' },
        },
        required: ['path', 'updatedContent'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityCoreMemoryUpdateDraft(runtime, args),
    },
    codex_continuity_core_memory_update_apply: {
      description: 'Apply a reviewed update to MEMORY.md or memory_summary.md with hash-based conflict protection.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Core memory file to update: MEMORY.md or memory_summary.md.' },
          updatedContent: { type: 'string', description: 'Full reviewed Markdown content to write.' },
          expectedHash: { type: 'string', description: 'SHA-256 hash returned by codex_continuity_core_memory_update_draft.' },
        },
        required: ['path', 'updatedContent', 'expectedHash'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityCoreMemoryUpdateApply(runtime, args),
    },
    codex_continuity_ad_hoc_note_write: {
      description: 'Write a new structured ad-hoc memory note under ~/.codex/memories/extensions/ad_hoc/notes/.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title.' },
          content: { type: 'string', description: 'Full Markdown content to write.' },
          slug: { type: 'string', description: 'Optional filename slug.' },
          timestamp: { type: 'string', description: 'Optional timestamp for deterministic filenames.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityWriteAdHocNote(runtime, args),
    },
    codex_continuity_note_settle: {
      description: 'Settle a completed session outcome into ad-hoc memory by updating a close note or creating a new one.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Candidate note title.' },
          content: { type: 'string', description: 'New durable outcome/delta to persist.' },
          cwd: { type: 'string', description: 'Optional current repo or cwd path.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Related paths for overlap detection.' },
          heading: { type: 'string', description: 'Heading used when updating an existing note.' },
          slug: { type: 'string', description: 'Optional filename slug for new notes.' },
          timestamp: { type: 'string', description: 'Optional timestamp for deterministic filenames.' },
          limit: { type: 'number', description: 'Max overlap hits to inspect.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      run: (args) => codexContinuitySettleAdHocNote(runtime, args),
    },
    codex_continuity_note_update_apply: {
      description: 'Apply a reviewed update to an existing ad-hoc memory note with hash-based conflict protection.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under ~/.codex/memories/extensions/ad_hoc/notes/.' },
          updatedContent: { type: 'string', description: 'Full reviewed Markdown content to write to the existing note.' },
          expectedHash: { type: 'string', description: 'SHA-256 hash returned by codex_continuity_note_update_draft.' },
        },
        required: ['path', 'updatedContent', 'expectedHash'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityNoteUpdateApply(runtime, args),
    },
    codex_continuity_note_update_draft: {
      description: 'Build a reviewable update draft for an existing memory note without mutating it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under ~/.codex/memories/extensions/ad_hoc/notes/ for the existing note to update.' },
          content: { type: 'string', description: 'New delta content to append or merge into the existing note.' },
          heading: { type: 'string', description: 'Optional heading for the generated update section.' },
          timestamp: { type: 'string', description: 'Optional timestamp for deterministic tests or review.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityNoteUpdateDraft(runtime, args),
    },
    codex_continuity_session_note_draft: {
      description: 'Build an ad-hoc memory note draft from a session digest and include overlap recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          digest: { type: 'object', description: 'Digest returned by codex_continuity_session_context/search/digest.' },
          type: { type: 'string', description: 'Optional note type label such as feature, bugfix, decision, or session.' },
          cwd: { type: 'string', description: 'Optional current repo or cwd path when digest.cwd is absent.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional related paths when digest.relatedPaths is absent.',
          },
          limit: { type: 'number', description: 'Max overlap hits to return (1-20).' },
        },
        required: ['digest'],
        additionalProperties: false,
      },
      run: (args) => codexContinuitySessionNoteDraft(runtime, args),
    },
    codex_continuity_recent_decisions: {
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
      run: (args) => codexContinuityRecentDecisions(runtime, args),
    },
    codex_continuity_overlap: {
      description: 'Find likely duplicate or overlapping memories before writing a new note.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Candidate note body or summary text.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Touched files or modules for overlap comparison.',
          },
          cwd: { type: 'string', description: 'Optional current repo or cwd path.' },
          limit: { type: 'number', description: 'Max overlap hits to return (1-20).' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityOverlap(runtime, args),
    },
    codex_continuity_read_note: {
      description: 'Read one memory artifact by path from the memories workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under ~/.codex/memories/.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args) => codexContinuityReadNote(runtime, args),
    },
  };
}

module.exports = {
  createToolRegistry,
  codexContinuityCoreMemoryUpdateApply,
  codexContinuityCoreMemoryUpdateDraft,
  codexContinuitySettleAdHocNote,
  codexContinuityWriteAdHocNote,
  codexContinuityNoteUpdateApply,
  codexContinuityNoteUpdateDraft,
  codexContinuityIndexStatus,
  codexContinuityProjectSummary,
  codexContinuityReadNote,
  codexContinuityRecentDecisions,
  codexContinuityRelatedFiles,
  codexContinuitySearch,
  codexContinuitySessionContext,
  codexContinuitySessionDigest,
  codexContinuitySessionNoteDraft,
  codexContinuitySessionSearch,
};
