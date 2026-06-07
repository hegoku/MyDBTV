const MEDIA_URL_PATTERN = /\.(m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:[?#]|$)/i;

function safeDecodeURIComponent(value) {
  let current = String(value || "");
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function decodeJsStringLiteral(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/"/g, '\\"')}"`);
  } catch {
    return String(value || "").replace(/\\\//g, "/");
  }
}

function decodePlayerUrl(rawUrl, encrypt) {
  let decoded = decodeJsStringLiteral(rawUrl);
  if (String(encrypt) === "2") {
    try {
      decoded = Buffer.from(decoded, "base64").toString("utf8");
    } catch {
      return safeDecodeURIComponent(decoded);
    }
  }
  return safeDecodeURIComponent(decoded);
}

function mediaFormatFromUrl(sourceUrl) {
  const match = String(sourceUrl || "").match(/\.(m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:[?#]|$)/i);
  if (!match) return "Media";
  if (match[1].toLowerCase() === "m3u8") return "HLS";
  if (match[1].toLowerCase() === "mpd") return "DASH";
  return match[1].toUpperCase();
}

function addMediaCandidate(candidates, seen, sourceUrl, baseUrl, source, name) {
  if (!sourceUrl) return;
  const cleaned = safeDecodeURIComponent(String(sourceUrl).trim());
  if (!MEDIA_URL_PATTERN.test(cleaned)) return;

  let resolved;
  try {
    resolved = new URL(cleaned, baseUrl).toString();
  } catch {
    return;
  }

  if (!/^https?:\/\//i.test(resolved) || seen.has(resolved)) return;
  seen.add(resolved);
  candidates.push({
    name: name || mediaFormatFromUrl(resolved),
    format: mediaFormatFromUrl(resolved),
    size: 0,
    url: resolved,
    source
  });
}

function extractMediaUrlsFromText(text, baseUrl, source, candidates, seen) {
  const raw = String(text || "");
  const directPattern = /https?:\/\/[^"' <>()\\]+?\.(?:m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:\?[^"' <>()\\]*)?/gi;
  const escapedPattern = /https?:\\\/\\\/[^"' <>()\\]+?(?:\\\/[^"' <>()\\]*)*?\.(?:m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:\?[^"' <>()\\]*)?/gi;
  const encodedPattern = /https?%3A%2F%2F[^"' <>()\\]+?\.(?:m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:%3F[^"' <>()\\]*)?/gi;
  let match;

  while ((match = directPattern.exec(raw))) {
    addMediaCandidate(candidates, seen, match[0].replace(/\\\//g, "/"), baseUrl, source);
  }
  while ((match = escapedPattern.exec(raw))) {
    addMediaCandidate(candidates, seen, match[0].replace(/\\\//g, "/"), baseUrl, source);
  }
  while ((match = encodedPattern.exec(raw))) {
    addMediaCandidate(candidates, seen, match[0], baseUrl, source);
  }
}

function extractPlayerConfigUrls(html, baseUrl) {
  const urls = [];
  const configPattern = /<script\b[^>]*>\s*var\s+(player_[a-z0-9_]+)\s*=\s*({[\s\S]*?})\s*<\/script>/gi;
  let match;

  while ((match = configPattern.exec(html))) {
    const configText = match[2];
    const urlMatch = configText.match(/["']url["']\s*:\s*["']([^"']+)["']/i);
    if (!urlMatch) continue;

    const encryptMatch = configText.match(/["']encrypt["']\s*:\s*["']?(\d+)["']?/i);
    const fromMatch = configText.match(/["']from["']\s*:\s*["']([^"']+)["']/i);
    const decodedUrl = decodePlayerUrl(urlMatch[1], encryptMatch ? encryptMatch[1] : "0");
    const entries = decodedUrl.split("#").map((entry) => entry.split("$").pop()).filter(Boolean);

    for (const entry of entries) {
      try {
        const resolved = new URL(entry, baseUrl).toString();
        if (/^https?:\/\//i.test(resolved)) {
          urls.push({
            url: resolved,
            source: `player config${fromMatch ? `: ${decodeJsStringLiteral(fromMatch[1])}` : ""}`
          });
        }
      } catch {
        // Ignore malformed player URLs.
      }
    }
  }

  return urls;
}

function extractPlayerConfigCandidates(html, baseUrl, candidates, seen) {
  for (const entry of extractPlayerConfigUrls(html, baseUrl)) {
    addMediaCandidate(
      candidates,
      seen,
      entry.url,
      baseUrl,
      entry.source,
      "Resolved media"
    );
    extractMediaUrlsFromText(entry.url, baseUrl, "player config", candidates, seen);
  }
}

function extractFrameUrls(html, baseUrl, decodeEntities) {
  const frames = [];
  const seen = new Set();
  const framePattern = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = framePattern.exec(html))) {
    try {
      const resolved = new URL(decodeEntities(match[1]), baseUrl).toString();
      if (/^https?:\/\//i.test(resolved) && !seen.has(resolved)) {
        seen.add(resolved);
        frames.push(resolved);
      }
    } catch {
      // Ignore malformed embedded frame URLs.
    }
    if (frames.length >= 3) break;
  }

  return frames;
}

function preferMediaCandidates(candidates) {
  const score = (candidate) => {
    const url = candidate.url.toLowerCase();
    if (url.includes(".m3u8")) return 40;
    if (url.includes(".mp4") || url.includes(".m4v")) return 35;
    if (url.includes(".webm") || url.includes(".ogv")) return 30;
    if (url.includes(".mpd")) return 10;
    return 0;
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}

module.exports = {
  MEDIA_URL_PATTERN,
  extractFrameUrls,
  extractMediaUrlsFromText,
  extractPlayerConfigCandidates,
  extractPlayerConfigUrls,
  preferMediaCandidates
};
