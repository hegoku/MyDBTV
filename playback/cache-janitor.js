const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isPathInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}

async function safeRm(cacheDir, targetPath) {
  if (!isPathInside(cacheDir, targetPath)) return;
  await fs.promises.rm(targetPath, { force: true, recursive: true });
}

async function collectFiles(cacheDir, currentDir = cacheDir, files = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(cacheDir, entryPath, files);
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const stats = await fs.promises.stat(entryPath);
      const relative = path.relative(cacheDir, entryPath);
      files.push({
        path: entryPath,
        sessionId: relative.split(path.sep)[0],
        size: stats.size,
        mtimeMs: stats.mtimeMs
      });
    } catch {
      // File may have disappeared between readdir and stat.
    }
  }

  return files;
}

async function pruneEmptyDirs(cacheDir, currentDir = cacheDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyDirs(cacheDir, path.join(currentDir, entry.name));
    }
  }

  if (currentDir === cacheDir) return;
  try {
    await fs.promises.rmdir(currentDir);
  } catch {
    // Directory is not empty or is in use.
  }
}

class CacheJanitor {
  constructor({
    cacheDir,
    maxBytes = DEFAULT_MAX_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    getActiveSessionIds = () => new Set()
  }) {
    this.cacheDir = cacheDir;
    this.maxBytes = normalizePositiveNumber(maxBytes, DEFAULT_MAX_BYTES);
    this.maxAgeMs = normalizePositiveNumber(maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.cleanupIntervalMs = normalizePositiveNumber(cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
    this.getActiveSessionIds = getActiveSessionIds;
    this.cleanupTimer = null;
    this.cleanupPromise = null;
  }

  schedule() {
    if (this.cleanupTimer || this.cleanupPromise) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.cleanupNow().catch(() => {});
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  cleanupNow() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.runCleanup()
      .finally(() => {
        this.cleanupPromise = null;
      });
    return this.cleanupPromise;
  }

  async runCleanup() {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const activeSessionIds = this.getActiveSessionIds();
    const now = Date.now();
    let files = await collectFiles(this.cacheDir);
    let total = files.reduce((sum, file) => sum + file.size, 0);

    for (const file of files) {
      if (activeSessionIds.has(file.sessionId)) continue;
      if (now - file.mtimeMs <= this.maxAgeMs) continue;
      await safeRm(this.cacheDir, file.path);
      total -= file.size;
    }

    files = await collectFiles(this.cacheDir);
    total = files.reduce((sum, file) => sum + file.size, 0);
    const removable = files
      .filter((file) => !activeSessionIds.has(file.sessionId))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of removable) {
      if (total <= this.maxBytes) break;
      await safeRm(this.cacheDir, file.path);
      total -= file.size;
    }

    await pruneEmptyDirs(this.cacheDir);
  }
}

module.exports = {
  CacheJanitor,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES
};
