const { BaseProvider } = require("./base-provider");
const { attrValue, decodeEntities, extractTitleFromHtml } = require("./html-utils");
const { resolveVideoWithHeadlessBrowser } = require("./headless-video-resolver");
const {
  extractFrameUrls,
  extractMediaUrlsFromText,
  extractPlayerConfigCandidates,
  extractPlayerConfigUrls,
  preferMediaCandidates
} = require("./media-utils");

function makeFongmiEmbedUrl(playerUrl, title) {
  const embedUrl = new URL("https://json.fongmi.cc/web");
  embedUrl.searchParams.set("url", playerUrl);
  if (title) embedUrl.searchParams.set("tittle", title);
  return embedUrl.toString();
}

class JfxqProvider extends BaseProvider {
  constructor() {
    super({
      id: "jfxq",
      name: "JFXQ",
      baseUrl: "https://jfxq.tv",
      detailPatterns: [/\/index\.php\/vod\/detail\/id\/\d+\.html/i, /\/voddetail\/\d+\.html/i],
      playPatterns: [/\/index\.php\/vod\/play\/id\/\d+/i, /\/vodplay\/\d+/i],
      hydrateSearchDetails: true
    });
  }

  searchUrls(query, page) {
    const q = encodeURIComponent(query);
    return [
      `${this.baseUrl}/index.php/vod/search/wd/${q}.html`,
      `${this.baseUrl}/index.php/vod/search/page/${page}/wd/${q}.html`,
      `${this.baseUrl}/vodsearch/${q}----------${page}---.html`
    ];
  }

  makePlayFile(name, url) {
    return {
      name: name.slice(0, 80),
      format: "JFXQ watch page",
      size: 0,
      url,
      resolvable: true
    };
  }

  parsePoster(html, sourceUrl) {
    const picMatch =
      html.match(/<div\b[^>]*class=["'][^"']*(?:role-card|vod|detail|pic|poster|thumb)[^"']*["'][^>]*>[\s\S]*?<img\b([^>]*)>/i) ||
      html.match(/<img\b([^>]*\b(?:data-original|data-src|src)\s*=\s*["'][^"']+["'][^>]*)>/i);
    const attrs = picMatch ? picMatch[1] : "";
    const poster = attrValue(attrs, "data-original") || attrValue(attrs, "data-src") || attrValue(attrs, "lay-src") || attrValue(attrs, "src");
    if (!poster || /(?:error|default|placeholder|img-bj-k)\.(?:png|jpe?g|webp|gif)/i.test(poster)) return "";
    return this.resolveUrl(poster, sourceUrl);
  }

  async resolveMedia(sourceUrl) {
    if (!this.isKnownUrl(sourceUrl)) {
      throw new Error("This is not a recognized JFXQ detail or watch page.");
    }

    const candidates = [];
    const seen = new Set();
    const html = await this.fetchHtml(sourceUrl);
    extractPlayerConfigCandidates(html, sourceUrl, candidates, seen);
    extractMediaUrlsFromText(html, sourceUrl, "page source", candidates, seen);

    for (const frameUrl of extractFrameUrls(html, sourceUrl, decodeEntities)) {
      try {
        const frameHtml = await this.fetchHtml(frameUrl);
        extractPlayerConfigCandidates(frameHtml, frameUrl, candidates, seen);
        extractMediaUrlsFromText(frameHtml, frameUrl, "embedded player", candidates, seen);
      } catch {
        // Keep candidates found on the main page even when an embedded player is unavailable.
      }
    }

    const sorted = preferMediaCandidates(candidates);
    if (!sorted.length) {
      const external = extractPlayerConfigUrls(html, sourceUrl)[0] || null;
      if (external) {
        const title = extractTitleFromHtml(html, "").replace(/[-_].*$/, "").trim();
        const isQqPlayer = /:\s*qq\b/i.test(external.source);
        const embedUrl = isQqPlayer ? makeFongmiEmbedUrl(external.url, title) : "";
        const externalCandidate = {
          name: isQqPlayer ? "Embedded player" : "Open external player",
          format: isQqPlayer ? "Embedded page" : "External page",
          size: 0,
          url: external.url,
          source: external.source,
          external: true,
          embedUrl,
          resolvable: false
        };

        if (embedUrl) {
          try {
            const resolved = await resolveVideoWithHeadlessBrowser(embedUrl);
            if (resolved) {
              const resolvedCandidate = {
                ...resolved,
                name: title || resolved.name,
                resolvedFrom: external.url
              };
              return {
                sourceUrl,
                selected: resolvedCandidate,
                candidates: [resolvedCandidate, externalCandidate]
              };
            }
          } catch {
            // Fall back to the embedded player if browser-based resolving is unavailable.
          }
        }

        return {
          sourceUrl,
          selected: externalCandidate,
          candidates: [externalCandidate]
        };
      }
    }

    return {
      sourceUrl,
      selected: sorted[0] || null,
      candidates: sorted
    };
  }
}

module.exports = {
  JfxqProvider
};
