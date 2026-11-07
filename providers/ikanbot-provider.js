const { BaseProvider, ProviderRegistry } = require("./base-provider");
const { attrValue, cleanText, extractTitleFromHtml } = require("./html-utils");

const MAX_PLAYABLE_FILES = 120;

function makeToken(videoId, encryptedToken) {
  const suffix = String(videoId || "").slice(-4);
  let source = String(encryptedToken || "");
  const parts = [];

  for (const character of suffix) {
    const offset = Number(character) % 3 + 1;
    parts.push(source.slice(offset, offset + 8));
    source = source.slice(offset + 8);
  }

  return parts.join("");
}

function extractSmallTexts(html) {
  return [...String(html || "").matchAll(/<span\b[^>]*class=["'][^"']*\bsmall\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
}

function extractSearchBlocks(html) {
  return String(html || "").split(/<div\b(?=[^>]*\bclass=["'](?:[^"']*\s)?media(?:\s[^"']*)?["'])[^>]*>/i).slice(1);
}

class IkanBotProvider extends BaseProvider {
  constructor() {
    super({
      id: "ikanbot",
      name: "IKanBot",
      baseUrl: "https://www.ikanbot.com",
      detailPatterns: [/\/play\/\d+\/?$/i],
      playPatterns: [/\/play\/\d+\/?$/i]
    });
  }

  searchUrls(query) {
    return [`${this.baseUrl}/search?q=${encodeURIComponent(query)}`];
  }

  async search(query, page) {
    if (!query) return { provider: this.name, page, total: 0, results: [], error: "" };

    try {
      let html = await this.fetchHtml(this.searchUrls(query)[0]);
      for (let currentPage = 1; currentPage < page; currentPage += 1) {
        const next = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*下一页\s*<\/a>/i);
        if (!next) break;
        html = await this.fetchHtml(this.resolveUrl(next[1], this.baseUrl));
      }
      const results = this.parseSearchResults(html, this.baseUrl);
      return { provider: this.name, page, total: results.length, results, error: "" };
    } catch (error) {
      return { provider: this.name, page, total: 0, results: [], error: error.message };
    }
  }

  parseSearchResults(html, fromUrl) {
    const results = [];
    const seen = new Set();

    for (const block of extractSearchBlocks(html)) {
      const href = (block.match(/<a\b[^>]*href=["']([^"']*\/play\/\d+[^"']*)["']/i) || [])[1];
      if (!href) continue;
      const sourceUrl = this.resolveUrl(href, fromUrl);
      if (!sourceUrl || seen.has(sourceUrl)) continue;

      const titleMatch = block.match(/<a\b[^>]*class=["'][^"']*\btitle-text\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      const titleAndYear = cleanText(titleMatch ? titleMatch[1] : "");
      const yearMatch = titleAndYear.match(/\b((?:19|20)\d{2})\b/);
      const title = titleAndYear.replace(/\s+(?:19|20)\d{2}\b/, "").trim();
      if (!title) continue;

      const imageAttrs = (block.match(/<img\b([^>]*)>/i) || [])[1] || "";
      const poster = (block.match(/https?:\/\/[^"'\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s<>]*)?/i) || [])[0] || attrValue(imageAttrs, "src");
      const [subject = "", creator = ""] = extractSmallTexts(block);

      seen.add(sourceUrl);
      results.push({
        id: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
        identifier: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
        title,
        creator,
        year: yearMatch ? yearMatch[1] : "",
        description: subject,
        poster: this.resolveUrl(poster, fromUrl),
        source: this.name,
        sourceUrl
      });
      if (results.length >= 24) break;
    }

    return results;
  }

  async getItem(sourceUrl) {
    if (!this.isKnownUrl(sourceUrl)) {
      throw new Error("This is not a recognized IKanBot play page.");
    }

    const html = await this.fetchHtml(sourceUrl);
    const media = await this.resolveMediaFromHtml(sourceUrl, html);
    const title = extractTitleFromHtml(html, "IKanBot video");
    const coverAttrs = (html.match(/<img\b[^>]*\bclass=["'][^"']*\bcover\b[^"']*["']([^>]*)>/i) || [])[1] || "";
    const metadata = extractSmallTexts(html);

    return {
      id: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
      identifier: ProviderRegistry.makeIdentifier(this.id, sourceUrl),
      title,
      creator: metadata[2] || "",
      year: metadata[1] || "",
      description: metadata.filter(Boolean).join(" / "),
      poster: this.resolveUrl(attrValue(coverAttrs, "data-src") || attrValue(coverAttrs, "src"), sourceUrl),
      source: this.name,
      sourceUrl,
      files: media.candidates
    };
  }

  async resolveMedia(sourceUrl) {
    if (!this.isKnownUrl(sourceUrl)) {
      throw new Error("This is not a recognized IKanBot play page.");
    }
    return this.resolveMediaFromHtml(sourceUrl, await this.fetchHtml(sourceUrl));
  }

  async resolveMediaFromHtml(sourceUrl, html) {
    const videoId = (html.match(/id=["']current_id["'][^>]*value=["'](\d+)["']/i) || [])[1];
    const encryptedToken = (html.match(/id=["']e_token["'][^>]*value=["']([^"']+)["']/i) || [])[1];
    const mtype = (html.match(/id=["']mtype["'][^>]*value=["']([^"']+)["']/i) || [])[1] || "";
    if (!videoId || !encryptedToken || !mtype) {
      throw new Error("IKanBot did not provide playable source data.");
    }

    const apiUrl = new URL("/api/getResN", this.baseUrl);
    apiUrl.searchParams.set("videoId", videoId);
    apiUrl.searchParams.set("mtype", mtype);
    apiUrl.searchParams.set("token", makeToken(videoId, encryptedToken));

    let response;
    try {
      response = await fetch(apiUrl, {
        headers: {
          accept: "application/json",
          referer: sourceUrl,
          "user-agent": "mytv-search-tool/1.0"
        }
      });
    } catch {
      throw new Error("Could not reach IKanBot's playback service.");
    }
    if (!response.ok) throw new Error(`IKanBot playback service returned ${response.status}.`);

    const payload = await response.json();
    if (payload.state !== 1 || !Array.isArray(payload.data?.list)) {
      throw new Error("IKanBot did not return playable media.");
    }

    const candidates = [];
    const seen = new Set();
    for (const [lineIndex, line] of payload.data.list.entries()) {
      let groups;
      try {
        groups = JSON.parse(line.resData || "[]");
      } catch {
        continue;
      }

      for (const group of groups) {
        const language = String(group.newName || "").trim();
        for (const part of String(group.url || "").split("#")) {
          const separator = part.indexOf("$");
          if (separator < 1) continue;
          const episode = part.slice(0, separator).trim();
          const url = part.slice(separator + 1).trim();
          if (!/\.m3u8(?:[?#]|$)/i.test(url) || seen.has(url)) continue;

          seen.add(url);
          candidates.push({
            name: [language, episode, `线路${lineIndex + 1}`].filter(Boolean).join(" · "),
            format: "HLS",
            size: 0,
            url,
            source: `IKanBot ${language || `线路${lineIndex + 1}`}`
          });
          if (candidates.length >= MAX_PLAYABLE_FILES) break;
        }
        if (candidates.length >= MAX_PLAYABLE_FILES) break;
      }
      if (candidates.length >= MAX_PLAYABLE_FILES) break;
    }

    return {
      sourceUrl,
      selected: candidates[0] || null,
      candidates
    };
  }
}

module.exports = {
  IkanBotProvider
};
