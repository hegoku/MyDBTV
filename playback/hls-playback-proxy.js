const { formatAttributes, parseAttributes } = require("./hls-playlist");

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(text);
}

function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    "content-length": buffer.byteLength,
    "cache-control": "public, max-age=31536000, immutable",
    ...headers
  });
  res.end(buffer);
}

function playlistProxyUrl(url) {
  return `/api/play/hls?url=${encodeURIComponent(url)}`;
}

function segmentProxyUrl(sessionId, segmentId) {
  return `/api/play/hls/segment?session=${encodeURIComponent(sessionId)}&segment=${encodeURIComponent(String(segmentId))}`;
}

function rewriteUriAttribute(line, toUrl) {
  return line.replace(/URI=("([^"]*)"|[^,]*)/i, (match, value, quoted) => {
    const rawUri = quoted === undefined ? value : quoted;
    const rewritten = toUrl(rawUri).replace(/"/g, '\\"');
    return `URI="${rewritten}"`;
  });
}

class HlsPlaybackProxy {
  constructor({ cache }) {
    this.cache = cache;
  }

  async handlePlaylist(requestUrl, res) {
    const url = String(requestUrl.searchParams.get("url") || "");
    const playlist = await this.cache.loadPlaylist(url);
    const body = playlist.type === "master"
      ? this.rewriteMasterPlaylist(playlist)
      : this.rewriteMediaPlaylist(playlist);

    sendText(res, 200, body, {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8"
    });
  }

  async handleSegment(requestUrl, res) {
    const sessionId = String(requestUrl.searchParams.get("session") || "");
    const segmentId = String(requestUrl.searchParams.get("segment") || "");
    if (!sessionId || !/^[a-f0-9]{24}$/i.test(segmentId)) {
      throw new Error("Invalid HLS segment request.");
    }

    const segment = await this.cache.readSegment(sessionId, segmentId);
    sendBuffer(res, 200, segment.buffer, {
      "content-type": segment.contentType
    });
  }

  rewriteMasterPlaylist(playlist) {
    const variantByLine = new Map(playlist.variants.map((variant) => [variant.lineIndex, variant]));
    return playlist.lines.flatMap((line, index) => {
      if (line.startsWith("#EXT-X-SESSION-KEY")) return [];
      const variant = variantByLine.get(index);
      if (variant) return playlistProxyUrl(variant.url);
      if (line.startsWith("#EXT-X-MEDIA")) {
        return rewriteUriAttribute(line, (uri) => playlistProxyUrl(new URL(uri, playlist.url).toString()));
      }
      return line;
    }).join("\n");
  }

  rewriteMediaPlaylist(playlist) {
    const sessionId = this.cache.sessionIdFor(playlist.url);

    return playlist.lines.flatMap((line, index) => {
      if (line.startsWith("#EXT-X-SESSION-KEY")) return [];
      if (playlist.keyLines.has(index) || playlist.byteRangeLines.has(index)) return [];

      const mapSegmentIndex = playlist.mapLineToSegment.get(index);
      if (mapSegmentIndex !== undefined) {
        return this.rewriteMapLine(line, segmentProxyUrl(sessionId, playlist.segments[mapSegmentIndex].playbackId));
      }

      const segmentIndex = playlist.segmentByLine.get(index);
      if (segmentIndex !== undefined) {
        return segmentProxyUrl(sessionId, playlist.segments[segmentIndex].playbackId);
      }

      return line;
    }).join("\n");
  }

  rewriteMapLine(line, url) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) return line;
    const attrs = parseAttributes(line.slice(colonIndex + 1));
    attrs.URI = url;
    delete attrs.BYTERANGE;
    return `${line.slice(0, colonIndex + 1)}${formatAttributes(attrs)}`;
  }
}

module.exports = {
  HlsPlaybackProxy
};
