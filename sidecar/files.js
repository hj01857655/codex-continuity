const fs = require('fs');
const path = require('path');

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

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

function relativeMemoryPath(runtime, filePath) {
  return path.relative(runtime.memoriesRoot, filePath).replace(/\\/g, '/');
}

function collectMemoryFiles(runtime) {
  const roots = [
    path.join(runtime.memoriesRoot, 'MEMORY.md'),
    path.join(runtime.memoriesRoot, 'memory_summary.md'),
    path.join(runtime.memoriesRoot, 'raw_memories.md'),
  ];

  const collected = [];
  for (const filePath of roots) {
    if (safeStat(filePath)?.isFile()) {
      collected.push(filePath);
    }
  }

  collected.push(...listMarkdownFiles(path.join(runtime.memoriesRoot, 'extensions', 'ad_hoc', 'notes')));
  collected.push(...listMarkdownFiles(path.join(runtime.memoriesRoot, 'rollout_summaries')));

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

module.exports = {
  collectMemoryFiles,
  relativeMemoryPath,
  safeRead,
  safeReadJson,
  safeStat,
  safeWriteJson,
};
