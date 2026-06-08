const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CacheJanitor } = require("./cache-janitor");
const { HlsPlaylistLoader, sequenceIv } = require("./hls-playlist");

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

function decryptAes128(buffer, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

class HlsPlaybackSession {
  constructor({ id, playlist }) {
    this.id = id;
    this.playlist = playlist;
    this.segmentById = new Map(playlist.segments.map((segment) => [segment.playbackId, segment]));
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  update(playlist) {
    this.playlist = playlist;
    this.segmentById = new Map(playlist.segments.map((segment) => [segment.playbackId, segment]));
    this.updatedAt = Date.now();
  }
}

class HlsPlaybackCache {
  constructor({
    cacheDir,
    loader = new HlsPlaylistLoader(),
    concurrency = DEFAULT_CONCURRENCY,
    prefetchAhead = DEFAULT_PREFETCH_AHEAD,
    maxCacheBytes,
    maxCacheAgeMs,
    cleanupIntervalMs
  }) {
    this.cacheDir = cacheDir;
    this.loader = loader;
    this.concurrency = normalizePositiveInt(concurrency, DEFAULT_CONCURRENCY, 12);
    this.prefetchAhead = normalizePositiveInt(prefetchAhead, DEFAULT_PREFETCH_AHEAD, 12);
    this.sessions = new Map();
    this.inflight = new Map();
    this.keyCache = new Map();
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

  segmentPath(sessionId, index) {
    return path.join(this.sessionDir(sessionId), `${String(index)}.segment`);
  }

  tempSegmentPath(sessionId, index) {
    return `${this.segmentPath(sessionId, index)}.part`;
  }

  async loadPlaylist(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) {
      throw new Error("A playable HTTP HLS URL is required.");
    }

    const playlist = await this.loader.load(url);
    this.preparePlaylist(playlist);
    if (playlist.type === "media" && !playlist.segments.length) {
      throw new Error("The HLS playlist does not contain playable segments.");
    }

    if (playlist.type === "media") {
      const id = this.sessionIdFor(playlist.url);
      const existing = this.sessions.get(id);
      if (existing) {
        existing.update(playlist);
      } else {
        this.sessions.set(id, new HlsPlaybackSession({ id, playlist }));
      }
      fs.mkdirSync(this.sessionDir(id), { recursive: true });
    }

    return playlist;
  }

  preparePlaylist(playlist) {
    if (playlist.type !== "media") return;
    playlist.segments.forEach((segment, index) => {
      segment.index = index;
      segment.playbackId = this.segmentIdFor(segment);
    });
  }

  segmentIdFor(segment) {
    const range = segment.byteRange ? `${segment.byteRange.offset}-${segment.byteRange.end}` : "full";
    return sha1(`${segment.kind}:${segment.sequenceNumber}:${segment.url}:${range}`).slice(0, 24);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The HLS playback session is no longer available.");
    return session;
  }

  async readSegment(sessionId, segmentId) {
    const session = this.getSession(sessionId);
    const segment = session.segmentById.get(segmentId);
    if (!segment) throw new Error("The requested HLS segment does not exist.");

    await this.ensureSegment(session, segment);
    this.prefetchAfter(session, segment.index);

    return {
      buffer: await this.readCachedSegment(session, segment),
      contentType: segment.contentType || "application/octet-stream"
    };
  }

  ensureSegment(session, segment) {
    const finalPath = this.segmentPath(session.id, segment.playbackId);
    if (fs.existsSync(finalPath)) {
      this.touchPath(finalPath);
      return Promise.resolve();
    }

    const key = `${session.id}:${segment.playbackId}`;
    if (!this.inflight.has(key)) {
      const task = this.downloadSegment(session, segment)
        .finally(() => {
          this.inflight.delete(key);
        });
      this.inflight.set(key, task);
    }
    return this.inflight.get(key);
  }

  prefetchAfter(session, index) {
    const end = Math.min(session.playlist.segments.length, index + 1 + this.prefetchAhead);
    const candidates = [];
    for (let next = index + 1; next < end; next += 1) {
      const segment = session.playlist.segments[next];
      const finalPath = this.segmentPath(session.id, segment.playbackId);
      const key = `${session.id}:${segment.playbackId}`;
      if (!fs.existsSync(finalPath) && !this.inflight.has(key)) {
        candidates.push(segment);
      }
    }

    const openSlots = Math.max(0, this.concurrency - this.inflight.size);
    for (const segment of candidates.slice(0, openSlots)) {
      this.ensureSegment(session, segment).catch(() => {
        // Foreground playback requests surface the real error when the segment is needed.
      });
    }
  }

  async downloadSegment(session, segment) {
    if (!segment) throw new Error("The requested HLS segment does not exist.");

    const tempPath = this.tempSegmentPath(session.id, segment.playbackId);
    const finalPath = this.segmentPath(session.id, segment.playbackId);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.rmSync(tempPath, { force: true });

    let buffer = await this.loadBytes(segment.url, segment.byteRange);
    if (segment.key?.method === "AES-128") {
      const key = await this.loadKey(segment.key.url);
      const iv = segment.key.iv || sequenceIv(segment.sequenceNumber);
      buffer = decryptAes128(buffer, key, iv);
    }

    await fs.promises.writeFile(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
    this.janitor.schedule();
  }

  async loadKey(url) {
    if (this.keyCache.has(url)) return this.keyCache.get(url);
    const buffer = await this.loadBytes(url);
    if (buffer.length !== 16) {
      throw new Error("HLS AES-128 keys must be 16 bytes.");
    }
    this.keyCache.set(url, buffer);
    return buffer;
  }

  async loadBytes(url, byteRange) {
    const headers = { "user-agent": "mytv-legal-media-tool/1.0" };
    if (byteRange) headers.range = `bytes=${byteRange.offset}-${byteRange.end}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HLS media request failed with ${response.status}.`);
    }
    if (byteRange && response.status !== 206) {
      throw new Error("The HLS server did not honor the byte-range request.");
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async readCachedSegment(session, segment) {
    const filePath = this.segmentPath(session.id, segment.playbackId);
    const buffer = await fs.promises.readFile(filePath);
    this.touchPath(filePath);
    return buffer;
  }

  touchPath(filePath) {
    const now = new Date();
    fs.promises.utimes(filePath, now, now).catch(() => {});
  }
}

module.exports = {
  HlsPlaybackCache
};
