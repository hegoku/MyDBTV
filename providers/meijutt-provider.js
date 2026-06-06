const { BaseProvider } = require("./base-provider");
const { attrValue, decodeEntities } = require("./html-utils");
const {
  extractFrameUrls,
  extractMediaUrlsFromText,
  extractPlayerConfigCandidates,
  preferMediaCandidates
} = require("./media-utils");

const MEIJUTT_HOSTS = [
  "www.meijutt.tv",
  "meijutt.tv",
  "www.meijutt.org",
  "meijutt.org",
  "www.mjtt.tv",
  "mjtt.tv",
  "www.imeijutt.net",
  "imeijutt.net",
  "www.imeijutt.tv",
  "imeijutt.tv"
];
const MEIJUTT_SEARCH_HOSTS = [
  "www.meijutt.tv",
  "www.meijutt.org"
];

class MeijuTTProvider extends BaseProvider {
  constructor() {
    super({
      id: "meijutt",
      name: "MeijuTT",
      baseUrl: "https://www.meijutt.tv",
      detailPatterns: [
        /\/content\/\d+\.html/i,
        /\/video\/\d+\.html/i,
        /\/vod-detail-id-\d+\.html/i,
        /\/index\.php\/vod\/detail\/id\/\d+\.html/i,
        /\/(?:mhkh|lyjs|dsqg|fzls|xzzx|dmkt|dy)\/[^/]+\/?$/i
      ],
      playPatterns: [
        /\/play\/\d+/i,
        /\/vod-play-/i,
        /\/index\.php\/vod\/play\/id\/\d+/i
      ],
      hydrateSearchDetails: true
    });
    this.hosts = MEIJUTT_HOSTS;
  }

  searchUrls(query, page) {
    const q = encodeURIComponent(query);
    const pathCandidates = page > 1
      ? [
        `/vod-search-wd-${q}-p-${page}.html`,
        `/index.php/vod/search/page/${page}/wd/${q}.html`,
        `/vodsearch/${q}----------${page}---.html`
      ]
      : [
        `/vod-search-wd-${q}.html`,
        `/index.php/vod/search/wd/${q}.html`,
        `/vodsearch/${q}-------------.html`
      ];

    return MEIJUTT_SEARCH_HOSTS.flatMap((host) => pathCandidates.map((path) => `https://${host}${path}`));
  }

  ownsUrl(sourceUrl) {
    try {
      const { hostname } = new URL(sourceUrl);
      return this.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }

  makePlayFile(name, url) {
    return {
      name: name.slice(0, 80),
      format: "MeijuTT watch page",
      size: 0,
      url,
      resolvable: true
    };
  }

  parsePoster(html, sourceUrl) {
    const picMatch =
      html.match(/<div\b[^>]*class=["'][^"']*(?:vod|detail|pic|poster|thumb)[^"']*["'][^>]*>[\s\S]*?<img\b([^>]*)>/i) ||
      html.match(/<img\b([^>]*\b(?:data-original|data-src|src)\s*=\s*["'][^"']+["'][^>]*)>/i);
    const attrs = picMatch ? picMatch[1] : "";
    const poster = attrValue(attrs, "data-original") || attrValue(attrs, "data-src") || attrValue(attrs, "lay-src") || attrValue(attrs, "src");
    if (!poster || /(?:error|default|placeholder)\.(?:png|jpe?g|webp|gif)/i.test(poster)) return "";
    return this.resolveUrl(poster, sourceUrl);
  }

  async resolveMedia(sourceUrl) {
    if (!this.isKnownUrl(sourceUrl)) {
      throw new Error("This is not a recognized MeijuTT detail or watch page.");
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
    return {
      sourceUrl,
      selected: sorted[0] || null,
      candidates: sorted
    };
  }
}

module.exports = {
  MeijuTTProvider
};
