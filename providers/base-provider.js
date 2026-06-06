const {
  attrValue,
  cleanText,
  extractLabeledValue,
  extractTitleFromHtml,
  isUsefulTitle
} = require("./html-utils");

class BaseProvider {
  constructor({ id, name, baseUrl, detailPatterns = [], playPatterns = [], hydrateSearchDetails = false }) {
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl;
    this.detailPatterns = detailPatterns;
    this.playPatterns = playPatterns;
    this.hydrateSearchDetails = hydrateSearchDetails;
  }

  searchUrls() {
    throw new Error(`${this.name} has not implemented searchUrls().`);
  }

  async search(query, page) {
    if (!query) return { provider: this.name, page, total: 0, results: [], error: "" };

    let lastError = "";
    for (const url of this.searchUrls(query, page)) {
      try {
        const html = await this.fetchHtml(url);
        const results = this.parseSearchResults(html, url);
        if (results.length) {
          const hydratedResults = this.hydrateSearchDetails ? await this.hydrateResults(results) : results;
          return { provider: this.name, page, total: hydratedResults.length, results: hydratedResults, error: "" };
        }
      } catch (error) {
        lastError = error.message;
      }
    }

    return { provider: this.name, page, total: 0, results: [], error: lastError };
  }

  async getItem(sourceUrl) {
    const html = await this.fetchHtml(sourceUrl);
    return this.parseDetail(html, sourceUrl);
  }

  async hydrateResults(results) {
    const hydrated = [];
    const batchSize = 6;

    for (let index = 0; index < results.length; index += batchSize) {
      const batch = results.slice(index, index + batchSize);
      const details = await Promise.all(batch.map(async (result) => {
        try {
          const detail = await this.getItem(result.sourceUrl);
          return {
            ...result,
            title: detail.title || result.title,
            creator: detail.creator || result.creator,
            year: detail.year || result.year,
            description: detail.description || result.description,
            poster: detail.poster || result.poster,
            source: detail.source || result.source
          };
        } catch {
          return result;
        }
      }));
      hydrated.push(...details);
    }

    return hydrated;
  }

  async resolveMedia() {
    throw new Error(`Media resolving is not configured for ${this.name}.`);
  }

  async fetchHtml(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "mytv-search-tool/1.0"
        }
      });
    } catch {
      throw new Error(`Could not reach ${this.name}.`);
    }

    if (!response.ok) {
      throw new Error(`${this.name} returned ${response.status}.`);
    }

    return response.text();
  }

  resolveUrl(href, fromUrl) {
    try {
      return new URL(href, fromUrl || this.baseUrl).toString();
    } catch {
      return "";
    }
  }

  ownsUrl(sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      const base = new URL(this.baseUrl);
      return url.hostname === base.hostname || url.hostname.endsWith(`.${base.hostname}`);
    } catch {
      return false;
    }
  }

  isDetailUrl(href) {
    return this.detailPatterns.some((pattern) => pattern.test(href));
  }

  isPlayUrl(href) {
    return this.playPatterns.some((pattern) => pattern.test(href));
  }

  isKnownUrl(sourceUrl) {
    return this.isDetailUrl(sourceUrl) || this.isPlayUrl(sourceUrl);
  }

  parseSearchResults(html, fromUrl) {
    const results = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorPattern.exec(html))) {
      const attrs = match[1];
      const body = match[2];
      const href = attrValue(attrs, "href");
      if (!href || !this.isDetailUrl(href)) continue;

      const sourceUrl = this.resolveUrl(href, fromUrl);
      if (!sourceUrl || seen.has(sourceUrl)) continue;

      const title = cleanText(attrValue(attrs, "title") || body);
      if (!isUsefulTitle(title)) continue;

      seen.add(sourceUrl);
      results.push({
        id: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
        identifier: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
        title,
        creator: "",
        year: "",
        description: "",
        poster: "",
        source: this.name,
        sourceUrl
      });

      if (results.length >= 24) break;
    }

    return results;
  }

  parseDetail(html, sourceUrl) {
    const bodyText = cleanText(html);
    const title = extractTitleFromHtml(html, sourceUrl);
    const year = extractLabeledValue(bodyText, ["\u5e74\u4efd", "\u5e74\u4ee3"]);
    const creator = extractLabeledValue(bodyText, ["\u5bfc\u6f14", "\u4e3b\u6f14"]);
    const description = extractLabeledValue(bodyText, ["\u7b80\u4ecb", "\u63cf\u8ff0"]);
    const poster = this.parsePoster(html, sourceUrl);
    const playLinks = this.parsePlayLinks(html, sourceUrl);

    return {
      id: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
      identifier: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
      title,
      creator,
      year,
      description,
      poster,
      source: this.name,
      sourceUrl,
      files: playLinks
    };
  }

  parsePlayLinks(html, sourceUrl) {
    const links = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorPattern.exec(html))) {
      const attrs = match[1];
      const href = attrValue(attrs, "href");
      if (!href || !this.isPlayUrl(href)) continue;

      const url = this.resolveUrl(href, sourceUrl);
      if (!url || seen.has(url)) continue;

      seen.add(url);
      links.push(this.makePlayFile(cleanText(match[2]) || `Episode ${links.length + 1}`, url));
      if (links.length >= 80) break;
    }

    if (!links.length) {
      links.push(this.makePlayFile("Open source page", sourceUrl));
    }

    return links;
  }

  makePlayFile(name, url) {
    return {
      name: name.slice(0, 80),
      format: "Source page",
      size: 0,
      url
    };
  }

  parsePoster() {
    return "";
  }
}

class ProviderRegistry {
  constructor(providers) {
    this.providers = providers;
  }

  static makeIdentifier(providerId, sourceUrl) {
    return `${providerId}:${Buffer.from(sourceUrl, "utf8").toString("base64url")}`;
  }

  parseIdentifier(identifier) {
    const [providerId, encoded] = String(identifier || "").split(":");
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider || !encoded) return null;
    return { provider, sourceUrl: Buffer.from(encoded, "base64url").toString("utf8") };
  }

  findByUrl(sourceUrl) {
    return this.providers.find((provider) => provider.ownsUrl(sourceUrl)) || null;
  }
}

module.exports = {
  BaseProvider,
  ProviderRegistry
};
