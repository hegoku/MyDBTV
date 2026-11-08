const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CacheJanitor } = require("./cache-janitor");

const CHUNK_SIZE = 4 * 1024 * 1024;
const SERVE_WINDOW_SIZE = 8 * 1024 * 1024;
const DEFAULT_PREFETCH_AHEAD = 4;
const DEFAULT_CONCURRENCY = 4;

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function normalizePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseContentRange(value) {
  const match = String(value || "").match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match || match[3] === "*") return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3])
  };
}

function contentTypeFor(url, headerValue) {
  if (headerValue) return headerValue;
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".m4v" || ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".ogv" || ext === ".ogg") return "video/ogg";
  return "application/octet-stream";
}

function parseRangeHeader(value, total) {
  if (!value) {
    return {
      start: 0,
      end: Math.min(SERVE_WINDOW_SIZE - 1, total - 1)
    };
  }

  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;

  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? Math.min(start + SERVE_WINDOW_SIZE - 1, total - 1) : Number(match[2]);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    end < start
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(end, total - 1)
  };
}

class DirectPlaybackSession {
  constructor({ id, url, total, contentType }) {
    this.id = id;
    this.url = url;
    this.total = total;
    this.contentType = contentType;
    this.controllers = new Set();
    this.closed = false;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  addController(controller) {
    this.controllers.add(controller);
  }

  removeController(controller) {
    this.controllers.delete(controller);
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

class DirectPlaybackCache {
  constructor({
    cacheDir,
    concurrency = DEFAULT_CONCURRENCY,
    prefetchAhead = DEFAULT_PREFETCH_AHEAD,
    maxCacheBytes,
    maxCacheAgeMs,
    cleanupIntervalMs
  }) {
    this.cacheDir = cacheDir;
    this.concurrency = normalizePositiveInt(concurrency, DEFAULT_CONCURRENCY, 12);
    this.prefetchAhead = normalizePositiveInt(prefetchAhead, DEFAULT_PREFETCH_AHEAD, 12);
    this.sessions = new Map();
    this.inflight = new Map();
    this.janitor = new CacheJanitor({
      cacheDir,
      maxBytes: maxCacheBytes,
      maxAgeMs: maxCacheAgeMs,
      cleanupIntervalMs,
      getActiveSessionIds: () => new Set(this.sessions.keys())
    });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.janitor.cleanupNow().catch(() => {});
  }

  sessionIdFor(url) {
    return sha1(url).slice(0, 24);
  }

  sessionDir(sessionId) {
    return path.join(this.cacheDir, sessionId);
  }

  chunkPath(sessionId, chunkIndex) {
    return path.join(this.sessionDir(sessionId), `${String(chunkIndex).padStart(8, "0")}.chunk`);
  }

  tempChunkPath(sessionId, chunkIndex) {
    return `${this.chunkPath(sessionId, chunkIndex)}.part`;
  }

  metaPath(sessionId) {
    return path.join(this.sessionDir(sessionId), "meta.json");
  }

  tryLoadPersistedSessionSync(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) return null;
    const id = this.sessionIdFor(url);
    const existing = this.sessions.get(id);
    if (existing && !existing.closed) {
      existing.updatedAt = Date.now();
      return existing;
    }
    const metaFile = this.metaPath(id);
    if (!fs.existsSync(metaFile)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      if (!data || !Number.isSafeInteger(data.total) || data.total <= 0) return null;
      const session = new DirectPlaybackSession({
        id,
        url,
        total: data.total,
        contentType: contentTypeFor(url, data.contentType)
      });
      this.sessions.set(id, session);
      return session;
    } catch {
      return null;
    }
  }

  peekStat(url) {
    const session = this.tryLoadPersistedSessionSync(url);
    if (!session) return null;
    return {
      size: session.total,
      contentType: session.contentType
    };
  }

  async getSession(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) {
      throw new Error("A playable HTTP media URL is required.");
    }

    const persisted = this.tryLoadPersistedSessionSync(url);
    if (persisted) return persisted;

    const id = this.sessionIdFor(url);
    if (this.sessionInflight.has(id)) {
      return this.sessionInflight.get(id);
    }

    const promise = (async () => {
      const probe = await this.probe(url);
      if (!probe.total || !probe.supportsRange) {
        throw new Error("This media server does not support byte-range playback.");
      }

      const contentType = contentTypeFor(url, probe.contentType);
      const session = new DirectPlaybackSession({
        id,
        url,
        total: probe.total,
        contentType
      });
      this.sessions.set(id, session);
      const dir = this.sessionDir(id);
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(this.metaPath(id), JSON.stringify({ url, total: probe.total, contentType }), "utf8");
      } catch {
        // Non-fatal if metadata persistence fails.
      }
      return session;
    })().finally(() => {
      this.sessionInflight.delete(id);
    });

    this.sessionInflight.set(id, promise);
    return promise;
  }

  async probe(url) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "user-agent": "mytv-legal-media-tool/1.0" }
      });
      if (response.ok) {
        const total = Number(response.headers.get("content-length") || 0);
        const supportsRange = /\bbytes\b/i.test(response.headers.get("accept-ranges") || "");
        if (total && supportsRange) {
          return {
            supportsRange: true,
            total,
            contentType: response.headers.get("content-type") || ""
          };
        }
      }
    } catch {
      // Some media hosts reject HEAD. A one-byte range probe follows.
    }

    const response = await fetch(url, {
      headers: {
        range: "bytes=0-0",
        "user-agent": "mytv-legal-media-tool/1.0"
      }
    });
    if (response.status !== 206) {
      return {
        supportsRange: false,
        total: Number(response.headers.get("content-length") || 0),
        contentType: response.headers.get("content-type") || ""
      };
    }

    const range = parseContentRange(response.headers.get("content-range"));
    await response.arrayBuffer();
    return {
      supportsRange: Boolean(range?.total),
      total: range?.total || 0,
      contentType: response.headers.get("content-type") || ""
    };
  }

  async readRange(url, rangeHeader) {
    const session = await this.getSession(url);
    const range = parseRangeHeader(rangeHeader, session.total);
    if (!range) {
      return {
        status: 416,
        headers: {
          "content-range": `bytes */${session.total}`,
          "accept-ranges": "bytes"
        },
        buffer: Buffer.alloc(0)
      };
    }

    await this.ensureRange(session, range.start, range.end);
    if (session.closed) throw new Error("The playback session has been closed.");
    this.prefetchAfter(session, Math.floor(range.end / CHUNK_SIZE));

    return {
      status: 206,
      headers: {
        "content-type": session.contentType,
        "accept-ranges": "bytes",
        "content-range": `bytes ${range.start}-${range.end}/${session.total}`
      },
      buffer: await this.readCachedBytes(session, range.start, range.end)
    };
  }

  // Protocol adapters (for example WebDAV or a future SMB server) read by
  // offset rather than by an HTTP Range header.  Keeping this here ensures
  // every adapter shares the same on-disk chunks and prefetch behaviour.
  async stat(url) {
    const session = await this.getSession(url);
    return {
      size: session.total,
      contentType: session.contentType
    };
  }

  async readAt(url, start, length) {
    const session = await this.getSession(url);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
      throw new Error("A valid file offset and length are required.");
    }
    if (start >= session.total || length === 0) return Buffer.alloc(0);

    const end = Math.min(start + length - 1, session.total - 1);
    await this.ensureRange(session, start, end);
    if (session.closed) throw new Error("The playback session has been closed.");
    this.prefetchAfter(session, Math.floor(end / CHUNK_SIZE));
    return this.readCachedBytes(session, start, end);
  }

  async ensureRange(session, start, end) {
    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor(end / CHUNK_SIZE);
    const chunks = [];
    for (let index = firstChunk; index <= lastChunk; index += 1) {
      chunks.push(index);
    }

    let offset = 0;
    while (offset < chunks.length) {
      const batch = chunks.slice(offset, offset + this.concurrency);
      await Promise.all(batch.map((chunkIndex) => this.ensureChunk(session, chunkIndex)));
      offset += this.concurrency;
    }
  }

  ensureChunk(session, chunkIndex) {
    if (session.closed) return Promise.reject(new Error("The playback session has been closed."));
    const finalPath = this.chunkPath(session.id, chunkIndex);
    if (fs.existsSync(finalPath)) {
      this.touchPath(finalPath);
      return Promise.resolve();
    }

    const key = `${session.id}:${chunkIndex}`;
    if (!this.inflight.has(key)) {
      const controller = new AbortController();
      const promise = this.downloadChunk(session, chunkIndex, controller)
        .finally(() => {
          this.inflight.delete(key);
        });
      this.inflight.set(key, {
        controller,
        promise,
        sessionId: session.id
      });
    }
    return this.inflight.get(key).promise;
  }

  prefetchAfter(session, chunkIndex) {
    if (session.closed) return;
    const maxChunk = Math.floor((session.total - 1) / CHUNK_SIZE);
    const candidates = [];
    for (let index = chunkIndex + 1; index <= Math.min(maxChunk, chunkIndex + this.prefetchAhead); index += 1) {
      const key = `${session.id}:${index}`;
      if (!fs.existsSync(this.chunkPath(session.id, index)) && !this.inflight.has(key)) {
        candidates.push(index);
      }
    }

    const openSlots = Math.max(0, this.concurrency - this.inflight.size);
    for (const index of candidates.slice(0, openSlots)) {
      this.ensureChunk(session, index).catch(() => {
        // Foreground range requests surface the real error when the chunk is needed.
      });
    }
  }

  async downloadChunk(session, chunkIndex, controller) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE - 1, session.total - 1);
    const tempPath = this.tempChunkPath(session.id, chunkIndex);
    const finalPath = this.chunkPath(session.id, chunkIndex);

    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.rmSync(tempPath, { force: true });
    session.addController(controller);

    try {
      const response = await fetch(session.url, {
        headers: {
          range: `bytes=${start}-${end}`,
          "user-agent": "mytv-legal-media-tool/1.0"
        },
        signal: controller.signal
      });
      if (response.status !== 206) {
        throw new Error("The media server did not honor a byte-range request.");
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength !== end - start + 1) {
        throw new Error("The media server returned an incomplete byte range.");
      }
      if (session.closed || controller.signal.aborted) return;

      await fs.promises.writeFile(tempPath, buffer);
      if (session.closed || controller.signal.aborted) {
        fs.rmSync(tempPath, { force: true });
        return;
      }
      fs.renameSync(tempPath, finalPath);
      this.janitor.schedule();
    } finally {
      session.removeController(controller);
    }
  }

  async readCachedBytes(session, start, end) {
    const buffers = [];
    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor(end / CHUNK_SIZE);

    for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
      const chunkStart = chunkIndex * CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, session.total - 1);
      const sliceStart = Math.max(start, chunkStart) - chunkStart;
      const sliceEnd = Math.min(end, chunkEnd) - chunkStart + 1;
      const chunkPath = this.chunkPath(session.id, chunkIndex);
      const chunk = await fs.promises.readFile(chunkPath);
      this.touchPath(chunkPath);
      buffers.push(chunk.subarray(sliceStart, sliceEnd));
    }

    return Buffer.concat(buffers);
  }

  closeByUrl(url) {
    return this.closeSession(this.sessionIdFor(url));
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.close();
    this.sessions.delete(sessionId);
    for (const [key, task] of this.inflight.entries()) {
      if (task.sessionId === sessionId) {
        task.controller.abort();
        this.inflight.delete(key);
      }
    }
    return true;
  }

  touchPath(filePath) {
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
  }
}

module.exports = {
  DirectPlaybackCache
};
