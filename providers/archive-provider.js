const path = require("path");
const { ProviderRegistry } = require("./base-provider");

const archiveCollections = {
  all: "(collection:feature_films OR collection:classic_tv OR collection:opensource_movies)",
  movie: "(collection:feature_films OR collection:opensource_movies)",
  tv: "collection:classic_tv"
};

class ArchiveProvider {
  constructor() {
    this.id = "archive";
    this.name = "Internet Archive";
    this.baseUrl = "https://archive.org";
    this.allowDownloads = true;
  }

  async search(query, page) {
    const collectionQuery = archiveCollections.all;
    const terms = ["mediatype:movies", collectionQuery];

    if (query) {
      const safeQuery = query.replace(/"/g, "");
      terms.push(`(title:"${safeQuery}" OR description:"${safeQuery}" OR subject:"${safeQuery}")`);
    }

    const url = new URL(`${this.baseUrl}/advancedsearch.php`);
    url.searchParams.set("q", terms.join(" AND "));
    url.searchParams.set("fl[]", "identifier");
    url.searchParams.append("fl[]", "title");
    url.searchParams.append("fl[]", "description");
    url.searchParams.append("fl[]", "creator");
    url.searchParams.append("fl[]", "date");
    url.searchParams.append("fl[]", "year");
    url.searchParams.append("fl[]", "collection");
    url.searchParams.set("rows", "24");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort[]", "downloads desc");
    url.searchParams.set("output", "json");

    let response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": "mytv-legal-media-tool/1.0" }
      });
    } catch {
      throw new Error("Could not reach Internet Archive. Check network access and try again.");
    }

    if (!response.ok) {
      throw new Error(`Internet Archive search failed with ${response.status}.`);
    }

    const data = await response.json();
    const docs = data?.response?.docs || [];
    return {
      provider: this.name,
      page,
      total: data?.response?.numFound || docs.length,
      results: docs.map((doc) => this.normalizeDoc(doc))
    };
  }

  async getItem(identifier) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(identifier)) {
      throw new Error("Invalid item identifier.");
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}/metadata/${encodeURIComponent(identifier)}`, {
        headers: { "user-agent": "mytv-legal-media-tool/1.0" }
      });
    } catch {
      throw new Error("Could not reach Internet Archive metadata. Check network access and try again.");
    }

    if (!response.ok) {
      throw new Error(`Internet Archive metadata failed with ${response.status}.`);
    }

    const data = await response.json();
    const metadata = data.metadata || {};
    const creator = Array.isArray(metadata.creator) ? metadata.creator.join(", ") : metadata.creator || "";
    const description = String(metadata.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const files = this.selectPlayableFiles(data.files || [], identifier);

    return {
      id: ProviderRegistry.makeIdentifier(this.id, identifier),
      identifier: ProviderRegistry.makeIdentifier(this.id, identifier),
      title: metadata.title || identifier,
      creator,
      year: metadata.year || (metadata.date ? String(metadata.date).slice(0, 4) : ""),
      description,
      poster: `${this.baseUrl}/services/img/${encodeURIComponent(identifier)}`,
      source: this.name,
      license: metadata.licenseurl || metadata.rights || "Review source page before downloading.",
      sourceUrl: `${this.baseUrl}/details/${encodeURIComponent(identifier)}`,
      files
    };
  }

  async getDownloadFile(identifier, fileName) {
    const item = await this.getItem(identifier);
    const file = item.files.find((candidate) => candidate.name === fileName);
    if (!file) {
      throw new Error("Requested file is not available for this item.");
    }
    return { item, file };
  }

  ownsUrl(sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      return url.hostname === "archive.org" || url.hostname.endsWith(".archive.org");
    } catch {
      return false;
    }
  }

  async resolveMedia() {
    throw new Error("Media resolving is not configured for Internet Archive pages.");
  }

  normalizeDoc(doc) {
    const year = Array.isArray(doc.year) ? doc.year[0] : doc.year;
    const date = Array.isArray(doc.date) ? doc.date[0] : doc.date;
    const creator = Array.isArray(doc.creator) ? doc.creator.join(", ") : doc.creator;
    const collection = Array.isArray(doc.collection) ? doc.collection : [doc.collection].filter(Boolean);
    return {
      id: ProviderRegistry.makeIdentifier(this.id, doc.identifier),
      identifier: ProviderRegistry.makeIdentifier(this.id, doc.identifier),
      title: doc.title || doc.identifier,
      creator: creator || "",
      year: year || (date ? String(date).slice(0, 4) : ""),
      description: String(doc.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      poster: `${this.baseUrl}/services/img/${encodeURIComponent(doc.identifier)}`,
      source: this.name,
      collection
    };
  }

  selectPlayableFiles(files, identifier) {
    const allowedExtensions = new Set([".mp4", ".m4v", ".webm", ".ogv"]);
    return files
      .filter((file) => {
        const ext = path.extname(file.name || "").toLowerCase();
        const format = String(file.format || "").toLowerCase();
        return allowedExtensions.has(ext) || format.includes("mpeg4") || format.includes("h.264");
      })
      .map((file) => ({
        name: file.name,
        format: file.format || path.extname(file.name).slice(1).toUpperCase(),
        size: Number(file.size || 0),
        url: this.fileUrl(identifier, file.name)
      }))
      .sort((a, b) => {
        const aScore = a.name.toLowerCase().includes("512kb") ? 0 : 1;
        const bScore = b.name.toLowerCase().includes("512kb") ? 0 : 1;
        return bScore - aScore || a.name.localeCompare(b.name);
      });
  }

  fileUrl(identifier, fileName) {
    return `${this.baseUrl}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName).replace(/%2F/g, "/")}`;
  }
}

module.exports = {
  ArchiveProvider
};
