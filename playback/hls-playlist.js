const path = require("path");

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

function formatAttributes(attrs) {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}=${/^[0-9.]+$/.test(String(value)) ? value : `"${String(value).replace(/"/g, '\\"')}"`}`)
    .join(",");
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

function mediaContentType(url, kind = "media") {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".m4s" || ext === ".mp4" || kind === "map") return "video/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".vtt") return "text/vtt; charset=utf-8";
  return "video/mp2t";
}

class HlsPlaylistLoader {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async loadText(url, { signal } = {}) {
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/vnd.apple.mpegurl, application/x-mpegurl, text/plain",
        "user-agent": "mytv-legal-media-tool/1.0"
      },
      signal
    });
    if (!response.ok) {
      throw new Error(`HLS playlist failed with ${response.status}.`);
    }
    return response.text();
  }

  async load(url, options = {}) {
    const text = await this.loadText(url, options);
    return this.parse(text, url);
  }

  parse(text, url) {
    const rawLines = text.split(/\r?\n/);
    const lines = rawLines.map((line) => line.trim());
    const variants = [];
    const segments = [];
    const segmentByLine = new Map();
    const byteRangeLines = new Set();
    const keyLines = new Set();
    const mapLineToSegment = new Map();
    let initMap = null;
    let currentKey = null;
    let mediaSequence = 0;
    let nextSegmentSequence = 0;
    let pendingByteRange = null;
    let pendingByteRangeLine = -1;
    let previousByteRangeEnd = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;

      if (line.startsWith("#EXT-X-KEY")) {
        keyLines.add(index);
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
        pendingByteRangeLine = index;
        byteRangeLines.add(index);
        continue;
      }

      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const attrs = parseAttributes(line);
        const nextLine = lines[index + 1] || "";
        if (nextLine && !nextLine.startsWith("#")) {
          variants.push({
            bandwidth: Number(attrs.BANDWIDTH || 0),
            url: resolvePlaylistUrl(nextLine, url),
            lineIndex: index + 1
          });
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
            kind: "map",
            url: resolvePlaylistUrl(attrs.URI, url),
            name: path.basename(attrs.URI),
            byteRange,
            key: currentKey,
            sequenceNumber: mediaSequence,
            lineIndex: index,
            contentType: mediaContentType(resolvePlaylistUrl(attrs.URI, url), "map")
          };
          const segmentIndex = segments.length;
          segments.push(initMap);
          mapLineToSegment.set(index, segmentIndex);
        }
        continue;
      }

      if (!line.startsWith("#")) {
        const sequenceNumber = nextSegmentSequence;
        nextSegmentSequence += 1;
        const segment = {
          kind: "media",
          url: resolvePlaylistUrl(line, url),
          name: path.basename(line),
          byteRange: pendingByteRange,
          byteRangeLine: pendingByteRangeLine,
          key: currentKey,
          sequenceNumber,
          lineIndex: index,
          contentType: mediaContentType(resolvePlaylistUrl(line, url), "media")
        };
        const segmentIndex = segments.length;
        segments.push(segment);
        segmentByLine.set(index, segmentIndex);
        pendingByteRange = null;
        pendingByteRangeLine = -1;
      }
    }

    return {
      url,
      text,
      lines,
      type: variants.length ? "master" : "media",
      variants,
      segments,
      segmentByLine,
      byteRangeLines,
      keyLines,
      mapLineToSegment,
      hasEndList: lines.some((line) => line === "#EXT-X-ENDLIST")
    };
  }
}

module.exports = {
  HlsPlaylistLoader,
  formatAttributes,
  parseAttributes,
  parseByteRange,
  parseIv,
  resolvePlaylistUrl,
  sequenceIv
};
