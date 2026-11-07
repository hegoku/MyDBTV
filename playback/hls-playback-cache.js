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
    this.virtualFiles = new Map();
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

  async loadVirtualFile(url) {
    let playlist = await this.loadPlaylist(url);
    if (playlist.type === "master") {
      const variant = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!variant) throw new Error("The HLS master playlist has no playable variant.");
      playlist = await this.loadPlaylist(variant.url);
    }
    if (!playlist.hasEndList) throw new Error("Live HLS playlists cannot be exposed as a stable virtual file.");
    if (playlist.hasDiscontinuity) throw new Error("HLS playlists with discontinuities cannot be exported as one virtual file.");
    // if (playlist.segments.some((segment) => segment.key?.method === "AES-128")) {
    //   throw new Error("AES-128 HLS cannot be exposed as a virtual file until its decrypted size is indexed.");
    // }

    const sessionId = this.sessionIdFor(playlist.url);
    const existing = this.virtualFiles.get(sessionId);
    if (existing) return existing;

    const session = this.getSession(sessionId);

    const isTransportStream = playlist.segments.every((segment) => segment.kind === "media" && segment.contentType === "video/mp2t");
    const isFragmentedMp4 = playlist.segments.every((segment) => segment.contentType === "video/mp4");
    if (!isTransportStream && !isFragmentedMp4) {
      throw new Error("This HLS segment layout cannot be represented as one media file.");
    }

    // const lengths = await this.mapWithConcurrency(playlist.segments, (segment) => this.segmentLength(segment));
    // AES-128 分片必须以解密后的实际长度作为索引
    const lengths = await this.mapWithConcurrency(
      playlist.segments,
      (segment) => {
        if (segment.key?.method === "AES-128") {
          return this.decryptedSegmentLength(segment);
        }

        return this.segmentLength(segment);
      }
    );
    let offset = 0;
    const segments = playlist.segments.map((segment, index) => {
      const entry = { segment, start: offset, length: lengths[index] };
      offset += entry.length;
      return entry;
    });
    const file = {
      sessionId,
      size: offset,
      contentType: isTransportStream ? "video/mp2t" : "video/mp4",
      extension: isTransportStream ? ".ts" : ".mp4",
      segments
    };
    this.virtualFiles.set(sessionId, file);
    return file;
  }

  async statVirtualFile(url) {
    const file = await this.loadVirtualFile(url);
    return { size: file.size, contentType: file.contentType, extension: file.extension };
  }

  async readVirtualAt(url, start, length) {
    const file = await this.loadVirtualFile(url);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
      throw new Error("A valid file offset and length are required.");
    }
    if (start >= file.size || length === 0) return Buffer.alloc(0);
    const end = Math.min(start + length, file.size);
    const session = this.getSession(file.sessionId);
    const buffers = [];
    for (const entry of file.segments) {
      const segmentEnd = entry.start + entry.length;
      if (segmentEnd <= start || entry.start >= end) continue;
      await this.ensureSegment(session, entry.segment);
      const buffer = await this.readCachedSegment(session, entry.segment);
      const from = Math.max(start, entry.start) - entry.start;
      const to = Math.min(end, segmentEnd) - entry.start;
      buffers.push(buffer.subarray(from, to));
    }
    return Buffer.concat(buffers);
  }

  async segmentLength(segment) {
    if (segment.byteRange) return segment.byteRange.length;
    try {
      const response = await fetch(segment.url, {
        method: "HEAD",
        headers: { "user-agent": "mytv-legal-media-tool/1.0" }
      });
      const length = Number(response.headers.get("content-length") || 0);
      if (response.ok && Number.isSafeInteger(length) && length > 0) return length;
    } catch {
      // A range probe handles media servers that reject HEAD.
    }
    const response = await fetch(segment.url, {
      headers: { range: "bytes=0-0", "user-agent": "mytv-legal-media-tool/1.0" }
    });
    const match = String(response.headers.get("content-range") || "").match(/bytes\s+\d+-\d+\/(\d+)/i);
    if (response.status !== 206 || !match) throw new Error("Unable to determine an HLS segment length.");
    return Number(match[1]);
  }

  async mapWithConcurrency(values, task) {
    const results = new Array(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await task(values[index]);
      }
    });
    await Promise.all(workers);
    return results;
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

  async decryptedSegmentLength(segment) {
    const encryptedLength = await this.segmentLength(segment);

    if (encryptedLength <= 0 || encryptedLength % 16 !== 0) {
      throw new Error("Invalid AES-128 encrypted segment length.");
    }

    const key = await this.loadKey(segment.key.url);
    const iv = segment.key.iv || sequenceIv(segment.sequenceNumber);

    // 只需要最後 1～2 個 AES Block
    const tailLength = Math.min(32, encryptedLength);

    const baseOffset = segment.byteRange
      ? segment.byteRange.offset
      : 0;

    const tail = await this.loadBytes(segment.url, {
      offset: baseOffset + encryptedLength - tailLength,
      end: baseOffset + encryptedLength - 1
    });

    if (tail.length !== tailLength) {
      throw new Error("Unable to read AES-128 segment tail.");
    }

    const previousBlock = tailLength === 16
      ? iv
      : tail.subarray(0, 16);

    const lastBlock = tail.subarray(tailLength - 16);

    // 只解密最後一個 Block，不處理整個視頻分片
    const decipher = crypto.createDecipheriv(
      "aes-128-cbc",
      key,
      previousBlock
    );

    decipher.setAutoPadding(false);

    const finalBlock = Buffer.concat([
      decipher.update(lastBlock),
      decipher.final()
    ]);

    const padding = finalBlock[15];

    if (
      padding < 1 ||
      padding > 16 ||
      !finalBlock.subarray(16 - padding).every(byte => byte === padding)
    ) {
      throw new Error("Invalid AES-128 PKCS#7 padding.");
    }

    return encryptedLength - padding;
  }
}

module.exports = {
  HlsPlaybackCache
};
