const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { BaseDownloader, finishStream, writeBuffer } = require("./base-downloader");

const SUPPORTED_KEY_METHODS = new Set(["NONE", "AES-128"]);

function parseAttributes(text) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    attrs[match[1].toUpperCase()] = String(match[2] || "").replace(/^"|"$/g, "");
  }
  return attrs;
}

function resolvePlaylistUrl(uri, baseUrl) {
  return new URL(uri, baseUrl).toString();
}

function parseByteRange(value, previousEnd = 0) {
  const [lengthText, offsetText] = String(value || "").split("@");
  const length = Number(lengthText || 0);
  const offset = offsetText === undefined ? previousEnd : Number(offsetText);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid HLS byte range.");
  }
  return {
    length,
    offset,
    end: offset + length - 1
  };
}

function parseIv(value) {
  if (!value) return null;
  const hex = String(value).replace(/^0x/i, "").padStart(32, "0");
  if (!/^[a-f0-9]{32}$/i.test(hex)) {
    throw new Error("Invalid HLS encryption IV.");
  }
  return Buffer.from(hex, "hex");
}

function sequenceIv(sequenceNumber) {
  const iv = Buffer.alloc(16, 0);
  iv.writeBigUInt64BE(BigInt(sequenceNumber), 8);
  return iv;
}

function decryptAes128(buffer, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

class HlsDownloader extends BaseDownloader {
  constructor(job) {
    super(job);
    this.keyCache = new Map();
  }

  get segmentDir() {
    return `${this.job.path}.segments`;
  }

  segmentPath(index) {
    return path.join(this.segmentDir, `${String(index).padStart(8, "0")}.segment`);
  }

  segmentTempPath(index) {
    return `${this.segmentPath(index)}.part`;
  }

  async start() {
    this.job.status = "downloading";
    this.job.error = "";
    this.touch();
    this.persistState();

    const playlist = await this.loadMediaPlaylist(this.job.url);
    if (!playlist.segments.length) {
      throw new Error("The HLS playlist does not contain downloadable segments.");
    }

    this.job.segmentCount = playlist.segments.length;
    this.setupSegmentPieces(playlist.segments.length);
    this.touch();
    this.persistState();

    await this.downloadSegmentsInParallel(playlist.segments);

    if (this.isStopped()) return;
    if (!this.job.pieces.every((piece) => piece.done)) {
      throw new Error("HLS download stopped before all segments completed.");
    }

    await this.assembleSegments(playlist.segments.length);
    if (this.isStopped()) return;

    fs.renameSync(this.tempPath, this.job.path);
    this.job.status = "complete";
    this.touch();
    this.persistState();
    this.cleanupSegmentFiles();
  }

  setupSegmentPieces(segmentCount) {
    fs.mkdirSync(this.segmentDir, { recursive: true });
    const existing = new Map((this.job.pieces || []).map((piece) => [piece.index, piece]));
    this.job.pieces = Array.from({ length: segmentCount }, (_, index) => {
      const filePath = this.segmentPath(index);
      const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      const persisted = existing.get(index);
      const done = Boolean(stats && (persisted?.done || !persisted));
      return {
        index,
        start: index,
        end: index,
        received: done ? stats.size : Number(persisted?.received || 0),
        done,
        active: false,
        dirty: true
      };
    });
    this.job.segmentIndex = this.job.pieces.filter((piece) => piece.done).length;
    this.job.pieceIndex = this.job.segmentIndex;
    this.job.pieceCount = segmentCount;
    this.job.received = this.job.pieces.reduce((sum, piece) => sum + (piece.done ? piece.received : 0), 0);
    this.job.total = this.job.received;
    this.job.store?.replacePieces(this.job.id, this.job.pieces);
  }

  async downloadSegmentsInParallel(segments) {
    let nextFetchIndex = 0;
    let activeWorkers = Math.max(0, Math.min(this.concurrency, segments.length));
    let workerError = null;

    const worker = async () => {
      while (!this.isStopped() && !workerError) {
        const index = this.nextPendingSegmentIndex(nextFetchIndex);
        if (index < 0) return;
        nextFetchIndex = index + 1;

        try {
          await this.downloadSegmentToFile(segments[index], this.job.pieces[index]);
        } catch (error) {
          if (this.isStopped() || error.name === "AbortError") return;
          workerError = error;
          return;
        }
      }
    };

    const workers = Array.from({ length: activeWorkers }, worker);
    await Promise.all(workers);
    if (workerError && !this.isStopped()) throw workerError;
  }

  nextPendingSegmentIndex(startIndex) {
    for (let index = startIndex; index < this.job.pieces.length; index += 1) {
      const piece = this.job.pieces[index];
      if (!piece.done && !piece.active) {
        piece.active = true;
        return index;
      }
    }
    for (const piece of this.job.pieces) {
      if (!piece.done && !piece.active) {
        piece.active = true;
        return piece.index;
      }
    }
    return -1;
  }

  async downloadSegmentToFile(segment, piece) {
    const finalPath = this.segmentPath(piece.index);
    if (piece.done && fs.existsSync(finalPath)) return;

    const tempPath = this.segmentTempPath(piece.index);
    try {
      fs.rmSync(tempPath, { force: true });
      const buffer = await this.loadSegment(segment);
      if (this.isStopped()) return;
      await fs.promises.writeFile(tempPath, buffer);
      fs.renameSync(tempPath, finalPath);
      piece.received = buffer.byteLength;
      piece.done = true;
      piece.dirty = true;
      this.job.received = this.job.pieces.reduce((sum, candidate) => sum + (candidate.done ? candidate.received : 0), 0);
      this.job.total = this.job.received;
      this.job.segmentIndex = this.job.pieces.filter((candidate) => candidate.done).length;
      this.job.pieceIndex = this.job.segmentIndex;
      this.touch();
      this.persistState();
    } finally {
      piece.active = false;
    }
  }

  async assembleSegments(segmentCount) {
    fs.rmSync(this.tempPath, { force: true });
    const fileStream = fs.createWriteStream(this.tempPath, { flags: "w" });
    try {
      for (let index = 0; index < segmentCount; index += 1) {
        if (this.isStopped()) return;
        await writeBuffer(fileStream, await fs.promises.readFile(this.segmentPath(index)));
      }
    } finally {
      await finishStream(fileStream);
    }
  }

  cleanupSegmentFiles() {
    try {
      fs.rmSync(this.segmentDir, { recursive: true, force: true });
    } catch {
      // Completed output is already assembled; segment cache cleanup is best effort.
    }
  }

  deleteFiles() {
    super.deleteFiles();
    this.cleanupSegmentFiles();
  }

  async loadSegment(segment) {
    let buffer = await this.loadBytes(segment.url, segment.byteRange);
    if (segment.key?.method === "AES-128") {
      const key = await this.loadKey(segment.key.url);
      const iv = segment.key.iv || sequenceIv(segment.sequenceNumber);
      buffer = decryptAes128(buffer, key, iv);
    }
    return buffer;
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
    if (byteRange) {
      headers.range = `bytes=${byteRange.offset}-${byteRange.end}`;
    }

    const controller = this.makeAbortController();
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HLS media request failed with ${response.status}.`);
      }
      if (byteRange && response.status !== 206) {
        throw new Error("The HLS server did not honor the byte-range request.");
      }

      return Buffer.from(await response.arrayBuffer());
    } finally {
      this.releaseAbortController(controller);
    }
  }

  async loadText(url) {
    const controller = this.makeAbortController();
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.apple.mpegurl, application/x-mpegurl, text/plain",
          "user-agent": "mytv-legal-media-tool/1.0"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HLS playlist failed with ${response.status}.`);
      }
      return response.text();
    } finally {
      this.releaseAbortController(controller);
    }
  }

  async loadMediaPlaylist(url, depth = 0) {
    if (depth > 3) {
      throw new Error("HLS playlist nesting is too deep.");
    }

    const text = await this.loadText(url);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants = [];
    const segments = [];
    let initMap = null;
    let currentKey = null;
    let mediaSequence = 0;
    let nextSegmentSequence = 0;
    let pendingByteRange = null;
    let previousByteRangeEnd = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("#EXT-X-KEY")) {
        const attrs = parseAttributes(line);
        const method = String(attrs.METHOD || "NONE").toUpperCase();
        if (!SUPPORTED_KEY_METHODS.has(method)) {
          throw new Error(`HLS encryption method ${method} is not supported.`);
        }
        if (method === "AES-128" && !attrs.URI) {
          throw new Error("HLS AES-128 keys must include a URI.");
        }
        if (attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity") {
          throw new Error(`HLS key format ${attrs.KEYFORMAT} is not supported.`);
        }
        currentKey = method === "NONE" ? null : {
          method,
          url: resolvePlaylistUrl(attrs.URI, url),
          iv: parseIv(attrs.IV)
        };
        continue;
      }
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        const value = Number(line.slice(line.indexOf(":") + 1));
        if (Number.isSafeInteger(value) && value >= 0) {
          mediaSequence = value;
          nextSegmentSequence = value;
        }
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE")) {
        pendingByteRange = parseByteRange(line.slice(line.indexOf(":") + 1), previousByteRangeEnd);
        previousByteRangeEnd = pendingByteRange.end + 1;
        continue;
      }
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const attrs = parseAttributes(line);
        const nextLine = lines[index + 1] || "";
        if (nextLine && !nextLine.startsWith("#")) {
          variants.push({
            bandwidth: Number(attrs.BANDWIDTH || 0),
            url: resolvePlaylistUrl(nextLine, url)
          });
          index += 1;
        }
        continue;
      }
      if (line.startsWith("#EXT-X-MAP")) {
        const attrs = parseAttributes(line);
        if (attrs.URI) {
          const byteRange = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) : null;
          if (currentKey?.method === "AES-128" && !currentKey.iv) {
            throw new Error("Encrypted HLS init maps require an explicit IV.");
          }
          initMap = {
            url: resolvePlaylistUrl(attrs.URI, url),
            name: path.basename(attrs.URI),
            byteRange,
            key: currentKey,
            sequenceNumber: mediaSequence
          };
        }
        continue;
      }
      if (!line.startsWith("#")) {
        const sequenceNumber = nextSegmentSequence;
        nextSegmentSequence += 1;
        segments.push({
          url: resolvePlaylistUrl(line, url),
          name: path.basename(line),
          byteRange: pendingByteRange,
          key: currentKey,
          sequenceNumber
        });
        pendingByteRange = null;
      }
    }

    if (variants.length) {
      const selected = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      this.job.variantUrl = selected.url;
      this.touch();
      this.persistState();
      return this.loadMediaPlaylist(selected.url, depth + 1);
    }

    return {
      url,
      segments: initMap ? [initMap, ...segments] : segments
    };
  }
}

module.exports = {
  HlsDownloader
};
