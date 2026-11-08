const path = require("path");

const DIRECT_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv", ".ogg", ".mkv", ".avi", ".flv"]);

function extensionFor(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return DIRECT_EXTENSIONS.has(extension) ? extension : "";
  } catch {
    return "";
  }
}

function isHlsUrl(url) {
  try {
    return path.extname(new URL(url).pathname).toLowerCase() === ".m3u8";
  } catch {
    return false;
  }
}

function safeFileName(value) {
  return String(value || "Untitled video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 150) || "Untitled video";
}

class FavoriteFileSystem {
  constructor({ favoriteStore, directPlaybackCache, hlsPlaybackCache }) {
    this.favoriteStore = favoriteStore;
    this.directPlaybackCache = directPlaybackCache;
    this.hlsPlaybackCache = hlsPlaybackCache;
    this.entryCache = new Map();
    this.entryByName = new Map();
    this.inflightById = new Map();

    setImmediate(() => {
      this.warmAll().catch(() => {});
    });
  }

  getCachedEntry(favorite) {
    const cached = this.entryCache.get(favorite.id);
    if (
      cached &&
      cached.videoUrl === favorite.videoUrl &&
      cached.title === favorite.title
    ) {
      cached.entry.favorite = favorite;
      cached.entry.createdAt = favorite.createdAt;
      return cached.entry;
    }
    return null;
  }

  storeCachedEntry(favorite, entry) {
    const previous = this.entryCache.get(favorite.id);
    if (previous && previous.entry.name !== entry.name) {
      this.entryByName.delete(previous.entry.name);
    }
    this.entryCache.set(favorite.id, {
      videoUrl: favorite.videoUrl,
      title: favorite.title,
      entry
    });
    this.entryByName.set(entry.name, entry);
    return entry;
  }

  evictFavorite(favoriteId) {
    const previous = this.entryCache.get(favoriteId);
    if (previous) {
      this.entryByName.delete(previous.entry.name);
      this.entryCache.delete(favoriteId);
    }
  }

  async resolveFavoriteEntry(favorite) {
    if (!favorite) return null;
    const cached = this.getCachedEntry(favorite);
    if (cached) return cached;

    if (this.inflightById.has(favorite.id)) {
      return this.inflightById.get(favorite.id);
    }

    const promise = (async () => {
      const extension = extensionFor(favorite.videoUrl);
      if (extension) {
        try {
          const media = this.directPlaybackCache.peekStat?.(favorite.videoUrl)
            || await this.directPlaybackCache.stat(favorite.videoUrl);
          return this.storeCachedEntry(favorite, {
            type: "file",
            name: `${safeFileName(favorite.title)} [${favorite.id.slice(0, 8)}]${extension}`,
            size: media.size,
            contentType: media.contentType,
            createdAt: favorite.createdAt,
            favorite,
            mediaType: "direct"
          });
        } catch (e) {
          console.log(e);
          return null;
        }
      }

      if (!isHlsUrl(favorite.videoUrl)) return null;
      try {
        const media = this.hlsPlaybackCache.peekVirtualFileStat?.(favorite.videoUrl)
          || await this.hlsPlaybackCache.statVirtualFile(favorite.videoUrl);
        return this.storeCachedEntry(favorite, {
          type: "file",
          name: `${safeFileName(favorite.title)} [${favorite.id.slice(0, 8)}]${media.extension}`,
          size: media.size,
          contentType: media.contentType,
          createdAt: favorite.createdAt,
          favorite,
          mediaType: "hls"
        });
      } catch (e) {
        // Do not expose an entry that cannot faithfully behave as one file.
        console.log(e);
        return null;
      }
    })().finally(() => {
      this.inflightById.delete(favorite.id);
    });

    this.inflightById.set(favorite.id, promise);
    return promise;
  }

  warmFavorite(favorite) {
    if (!favorite) return Promise.resolve(null);
    return this.resolveFavoriteEntry(favorite).catch(() => null);
  }

  async warmAll() {
    const favorites = this.favoriteStore.list();
    await Promise.all(favorites.map((favorite) => this.warmFavorite(favorite)));
  }

  async entries() {
    const favorites = this.favoriteStore.list();
    const activeIds = new Set(favorites.map((favorite) => favorite.id));
    for (const cachedId of this.entryCache.keys()) {
      if (!activeIds.has(cachedId)) {
        this.evictFavorite(cachedId);
      }
    }

    const entries = await Promise.all(
      favorites.map((favorite) => this.resolveFavoriteEntry(favorite))
    );
    return entries.filter(Boolean);
  }

  async readdir(virtualPath = "/") {
    if (virtualPath !== "/") throw new Error("Not a directory.");
    return (await this.entries()).map(({ name, size, contentType, createdAt }) => ({
      type: "file",
      name,
      size,
      contentType,
      createdAt
    }));
  }

  async findFile(virtualPath) {
    if (!virtualPath.startsWith("/") || virtualPath.slice(1).includes("/")) return null;
    const name = virtualPath.slice(1);

    const byName = this.entryByName.get(name);
    if (byName) {
      const stillExists = this.favoriteStore.get?.(byName.favorite.id);
      if (stillExists) {
        const refreshed = this.getCachedEntry(stillExists);
        if (refreshed && refreshed.name === name) return refreshed;
      } else if (!this.favoriteStore.get) {
        return byName;
      }
      this.entryByName.delete(name);
    }

    const idPrefixMatch = name.match(/\[([A-Za-z0-9_-]{8})\]\.[A-Za-z0-9]+$/);
    if (idPrefixMatch) {
      const prefix = idPrefixMatch[1];
      const match = this.favoriteStore.list().find((favorite) => favorite.id.startsWith(prefix));
      if (match) {
        const entry = await this.resolveFavoriteEntry(match);
        if (entry && entry.name === name) return entry;
      }
    }

    return (await this.entries()).find((entry) => entry.name === name) || null;
  }

  async stat(virtualPath) {
    if (virtualPath === "/") return { type: "directory", size: 0, createdAt: new Date(0).toISOString() };
    const entry = await this.findFile(virtualPath);
    if (!entry) return null;
    return {
      type: "file",
      size: entry.size,
      contentType: entry.contentType,
      createdAt: entry.createdAt
    };
  }

  async read(virtualPath, offset, length) {
    const entry = await this.findFile(virtualPath);
    if (!entry) return null;
    return entry.mediaType === "hls"
      ? this.hlsPlaybackCache.readVirtualAt(entry.favorite.videoUrl, offset, length)
      : this.directPlaybackCache.readAt(entry.favorite.videoUrl, offset, length);
  }
}

module.exports = { FavoriteFileSystem };
