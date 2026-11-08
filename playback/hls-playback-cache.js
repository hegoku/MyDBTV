const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CacheJanitor } = require("./cache-janitor");
const { HlsPlaylistLoader, sequenceIv } = require("./hls-playlist");

const DEFAULT_PREFETCH_AHEAD = 4;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INDEX_CONCURRENCY = 16;

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

function findFirstSegmentIndex(segments, offset) {
  let low = 0;
  let high = segments.length - 1;
  let result = segments.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = segments[mid];
    if (entry.start + entry.length > offset) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
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
    indexConcurrency = DEFAULT_INDEX_CONCURRENCY,
    prefetchAhead = DEFAULT_PREFETCH_AHEAD,
    maxCacheBytes,
    maxCacheAgeMs,
    cleanupIntervalMs
  }) {
    this.cacheDir = cacheDir;
    this.loader = loader;
    this.concurrency = normalizePositiveInt(concurrency, DEFAULT_CONCURRENCY, 12);
    this.indexConcurrency = normalizePositiveInt(indexConcurrency, DEFAULT_INDEX_CONCURRENCY, 64);
    this.prefetchAhead = normalizePositiveInt(prefetchAhead, DEFAULT_PREFETCH_AHEAD, 12);
    this.sessions = new Map();
    this.inflight = new Map();
    this.keyCache = new Map();
    this.keyInflight = new Map();
    this.virtualFiles = new Map();
    this.virtualFilesByUrl = new Map();
    this.virtualFileInflight = new Map();
    this.janitor = new CacheJanitor({
      cacheDir,
      maxBytes: maxCacheBytes,
      maxAgeMs: maxCacheAgeMs,
      cleanupIntervalMs,
      getActiveSessionIds: () => new Set([...this.sessions.keys(), ...this.virtualFiles.keys()])
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

  virtualFileIndexPath(sessionId) {
    return path.join(this.sessionDir(sessionId), "virtual-file.json");
  }

  registerVirtualFile(file, sourceUrl) {
    this.virtualFiles.set(file.sessionId, file);
    if (file.playlistUrl) {
      this.virtualFilesByUrl.set(file.playlistUrl, file);
    }
    if (sourceUrl) {
      this.virtualFilesByUrl.set(sourceUrl, file);
    }
    if (!this.sessions.has(file.sessionId)) {
      const playlist = {
        url: file.playlistUrl || sourceUrl || "",
        type: "media",
        segments: file.segments.map((entry) => entry.segment),
        hasEndList: true,
        hasDiscontinuity: false
      };
      this.sessions.set(file.sessionId, new HlsPlaybackSession({ id: file.sessionId, playlist }));
    }
    fs.mkdirSync(this.sessionDir(file.sessionId), { recursive: true });
    return file;
  }

  tryLoadPersistedVirtualFileSync(url) {
    if (!url) return null;
    const mem = this.virtualFilesByUrl.get(url);
    if (mem) return mem;

    const initialSessionId = this.sessionIdFor(url);
    const initialPath = this.virtualFileIndexPath(initialSessionId);
    if (!fs.existsSync(initialPath)) return null;

    try {
      let data = JSON.parse(fs.readFileSync(initialPath, "utf8"));
      if (data && data.redirectSessionId) {
        const targetPath = this.virtualFileIndexPath(data.redirectSessionId);
        if (!fs.existsSync(targetPath)) return null;
        data = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      }
      if (
        !data ||
        data.version !== 1 ||
        !data.sessionId ||
        !Number.isSafeInteger(data.size) ||
        !Array.isArray(data.segments) ||
        !data.segments.length
      ) {
        return null;
      }

      const segments = data.segments.map((entry, idx) => {
        const rawSeg = entry.segment || {};
        const key = rawSeg.key
          ? {
              method: rawSeg.key.method,
              url: rawSeg.key.url,
              iv: rawSeg.key.ivHex ? Buffer.from(rawSeg.key.ivHex, "hex") : null
            }
          : null;
        const segment = {
          index: Number.isSafeInteger(rawSeg.index) ? rawSeg.index : idx,
          playbackId: rawSeg.playbackId,
          kind: rawSeg.kind || "media",
          url: rawSeg.url,
          name: rawSeg.name || "",
          byteRange: rawSeg.byteRange || null,
          key,
          sequenceNumber: rawSeg.sequenceNumber || 0,
          contentType: rawSeg.contentType || data.contentType
        };
        if (!segment.playbackId) {
          segment.playbackId = this.segmentIdFor(segment);
        }
        return {
          segment,
          start: entry.start,
          length: entry.length
        };
      });

      const file = {
        sessionId: data.sessionId,
        playlistUrl: data.playlistUrl || url,
        size: data.size,
        contentType: data.contentType,
        extension: data.extension,
        segments
      };
      return this.registerVirtualFile(file, url);
    } catch {
      return null;
    }
  }

  async persistVirtualFile(file, sourceUrl) {
    try {
      const payload = {
        version: 1,
        sessionId: file.sessionId,
        playlistUrl: file.playlistUrl,
        size: file.size,
        contentType: file.contentType,
        extension: file.extension,
        updatedAt: new Date().toISOString(),
        segments: file.segments.map(({ start, length, segment }) => ({
          start,
          length,
          segment: {
            index: segment.index,
            playbackId: segment.playbackId,
            kind: segment.kind,
            url: segment.url,
            name: segment.name,
            byteRange: segment.byteRange || null,
            sequenceNumber: segment.sequenceNumber,
            contentType: segment.contentType,
            key: segment.key
              ? {
                  method: segment.key.method,
                  url: segment.key.url,
                  ivHex: segment.key.iv ? Buffer.from(segment.key.iv).toString("hex") : null
                }
              : null
          }
        }))
      };

      const targetDir = this.sessionDir(file.sessionId);
      await fs.promises.mkdir(targetDir, { recursive: true });
      const targetPath = this.virtualFileIndexPath(file.sessionId);
      const tempPath = `${targetPath}.part`;
      await fs.promises.writeFile(tempPath, JSON.stringify(payload), "utf8");
      await fs.promises.rename(tempPath, targetPath);

      const sourceSessionId = sourceUrl ? this.sessionIdFor(sourceUrl) : file.sessionId;
      if (sourceSessionId !== file.sessionId) {
        const aliasDir = this.sessionDir(sourceSessionId);
        await fs.promises.mkdir(aliasDir, { recursive: true });
        const aliasPath = this.virtualFileIndexPath(sourceSessionId);
        const aliasTempPath = `${aliasPath}.part`;
        const aliasPayload = {
          version: 1,
          redirectSessionId: file.sessionId,
          playlistUrl: file.playlistUrl,
          updatedAt: payload.updatedAt
        };
        await fs.promises.writeFile(aliasTempPath, JSON.stringify(aliasPayload), "utf8");
        await fs.promises.rename(aliasTempPath, aliasPath);
      }
    } catch {
      // Non-fatal if disk persistence fails.
    }
  }

  peekVirtualFileStat(url) {
    const file = this.tryLoadPersistedVirtualFileSync(url);
    if (!file) return null;
    return {
      size: file.size,
      contentType: file.contentType,
      extension: file.extension
    };
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
    const cached = this.tryLoadPersistedVirtualFileSync(url);
    if (cached) return cached;

    if (this.virtualFileInflight.has(url)) {
      return this.virtualFileInflight.get(url);
    }

    const promise = this.buildVirtualFile(url).finally(() => {
      this.virtualFileInflight.delete(url);
    });
    this.virtualFileInflight.set(url, promise);
    return promise;
  }

  async buildVirtualFile(url) {
    let playlist = await this.loadPlaylist(url);
    if (playlist.type === "master") {
      const variant = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!variant) throw new Error("The HLS master playlist has no playable variant.");
      const cachedVariant = this.tryLoadPersistedVirtualFileSync(variant.url);
      if (cachedVariant) {
        this.registerVirtualFile(cachedVariant, url);
        await this.persistVirtualFile(cachedVariant, url);
        return cachedVariant;
      }
      playlist = await this.loadPlaylist(variant.url);
    }
    if (!playlist.hasEndList) throw new Error("Live HLS playlists cannot be exposed as a stable virtual file.");
    if (playlist.hasDiscontinuity) throw new Error("HLS playlists with discontinuities cannot be exported as one virtual file.");

    const sessionId = this.sessionIdFor(playlist.url);
    const existing = this.virtualFiles.get(sessionId) || this.tryLoadPersistedVirtualFileSync(playlist.url);
    if (existing) {
      this.registerVirtualFile(existing, url);
      await this.persistVirtualFile(existing, url);
      return existing;
    }

    const isTransportStream = playlist.segments.every((segment) => segment.kind === "media" && segment.contentType === "video/mp2t");
    const isFragmentedMp4 = playlist.segments.every((segment) => segment.contentType === "video/mp4");
    if (!isTransportStream && !isFragmentedMp4) {
      throw new Error("This HLS segment layout cannot be represented as one media file.");
    }

    // Pre-fetch unique AES-128 keys once before probing segments in parallel.
    const keyUrls = new Set();
    for (const segment of playlist.segments) {
      if (segment.key?.method === "AES-128" && segment.key.url) {
        keyUrls.add(segment.key.url);
      }
    }
    if (keyUrls.size > 0) {
      await Promise.all([...keyUrls].map((keyUrl) => this.loadKey(keyUrl)));
    }

    const lengths = await this.mapWithConcurrency(
      playlist.segments,
      (segment) => {
        const cachedFile = this.segmentPath(sessionId, segment.playbackId);
        try {
          const stats = fs.statSync(cachedFile);
          if (stats.isFile() && stats.size > 0) {
            return stats.size;
          }
        } catch {
          // Segment is not cached locally yet.
        }

        if (segment.key?.method === "AES-128") {
          return this.decryptedSegmentLength(segment);
        }

        return this.segmentLength(segment);
      },
      this.indexConcurrency
    );

    let offset = 0;
    const segments = playlist.segments.map((segment, index) => {
      const entry = { segment, start: offset, length: lengths[index] };
      offset += entry.length;
      return entry;
    });
    const file = {
      sessionId,
      playlistUrl: playlist.url,
      size: offset,
      contentType: isTransportStream ? "video/mp2t" : "video/mp4",
      extension: isTransportStream ? ".ts" : ".mp4",
      segments
    };
    this.registerVirtualFile(file, url);
    await this.persistVirtualFile(file, url);
    return file;
  }

  async statVirtualFile(url) {
    const fast = this.peekVirtualFileStat(url);
    if (fast) return fast;
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

    const firstIdx = findFirstSegmentIndex(file.segments, start);
    const overlapping = [];
    for (let i = firstIdx; i < file.segments.length; i += 1) {
      const entry = file.segments[i];
      if (entry.start >= end) break;
      overlapping.push(entry);
    }
    if (!overlapping.length) return Buffer.alloc(0);

    await Promise.all(overlapping.map((entry) => this.ensureSegment(session, entry.segment)));
    const lastEntry = overlapping[overlapping.length - 1];
    if (lastEntry && Number.isSafeInteger(lastEntry.segment.index)) {
      this.prefetchAfter(session, lastEntry.segment.index);
    }

    const buffers = [];
    for (const entry of overlapping) {
      const segmentEnd = entry.start + entry.length;
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
    await response.arrayBuffer().catch(() => {});
    if (response.status !== 206 || !match) throw new Error("Unable to determine an HLS segment length.");
    return Number(match[1]);
  }

  async mapWithConcurrency(values, task, concurrency = this.concurrency) {
    const results = new Array(values.length);
    let next = 0;
    const workerCount = Math.min(normalizePositiveInt(concurrency, this.concurrency, 64), values.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await task(values[index], index);
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
    if (this.keyInflight.has(url)) return this.keyInflight.get(url);

    const promise = (async () => {
      const buffer = await this.loadBytes(url);
      if (buffer.length !== 16) {
        throw new Error("HLS AES-128 keys must be 16 bytes.");
      }
      this.keyCache.set(url, buffer);
      return buffer;
    })().finally(() => {
      this.keyInflight.delete(url);
    });

    this.keyInflight.set(url, promise);
    return promise;
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

  async trySuffixRangeTail(url) {
    try {
      const response = await fetch(url, {
        headers: {
          range: "bytes=-32",
          "user-agent": "mytv-legal-media-tool/1.0"
        }
      });
      if (response.status !== 206) {
        await response.arrayBuffer().catch(() => {});
        return null;
      }
      const match = String(response.headers.get("content-range") || "").match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
      const tail = Buffer.from(await response.arrayBuffer());
      if (!match) return null;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      const expectedLength = Math.min(32, total);
      if (
        !Number.isSafeInteger(total) ||
        total <= 0 ||
        total % 16 !== 0 ||
        end !== total - 1 ||
        end - start + 1 !== expectedLength ||
        tail.length !== expectedLength
      ) {
        return null;
      }
      return { encryptedLength: total, tail };
    } catch {
      return null;
    }
  }

  async decryptedSegmentLength(segment) {
    const key = await this.loadKey(segment.key.url);
    const iv = segment.key.iv || sequenceIv(segment.sequenceNumber);

    let encryptedLength = 0;
    let tail = null;

    if (!segment.byteRange) {
      const suffixProbe = await this.trySuffixRangeTail(segment.url);
      if (suffixProbe) {
        encryptedLength = suffixProbe.encryptedLength;
        tail = suffixProbe.tail;
      }
    }

    if (!tail) {
      encryptedLength = await this.segmentLength(segment);
      if (encryptedLength <= 0 || encryptedLength % 16 !== 0) {
        throw new Error("Invalid AES-128 encrypted segment length.");
      }

      const tailLength = Math.min(32, encryptedLength);
      const baseOffset = segment.byteRange ? segment.byteRange.offset : 0;
      tail = await this.loadBytes(segment.url, {
        offset: baseOffset + encryptedLength - tailLength,
        end: baseOffset + encryptedLength - 1
      });
      if (tail.length !== tailLength) {
        throw new Error("Unable to read AES-128 segment tail.");
      }
    }

    const tailLength = tail.length;
    const previousBlock = tailLength === 16 ? iv : tail.subarray(0, 16);
    const lastBlock = tail.subarray(tailLength - 16);

    const decipher = crypto.createDecipheriv("aes-128-cbc", key, previousBlock);
    decipher.setAutoPadding(false);

    const finalBlock = Buffer.concat([
      decipher.update(lastBlock),
      decipher.final()
    ]);

    const padding = finalBlock[15];
    if (
      padding < 1 ||
      padding > 16 ||
      !finalBlock.subarray(16 - padding).every((byte) => byte === padding)
    ) {
      throw new Error("Invalid AES-128 PKCS#7 padding.");
    }

    return encryptedLength - padding;
  }
}

module.exports = {
  HlsPlaybackCache
};
