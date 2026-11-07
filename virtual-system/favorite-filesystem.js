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
  }

  async entries() {
    const entries = await Promise.all(this.favoriteStore.list().map(async (favorite) => {
        const extension = extensionFor(favorite.videoUrl);
        if (extension) {
          return {
            type: "file",
            name: `${safeFileName(favorite.title)} [${favorite.id.slice(0, 8)}]${extension}`,
            favorite,
            mediaType: "direct"
          };
        }
        if (!isHlsUrl(favorite.videoUrl)) return null;
        try {
          const media = await this.hlsPlaybackCache.statVirtualFile(favorite.videoUrl);
          return {
            type: "file",
            name: `${safeFileName(favorite.title)} [${favorite.id.slice(0, 8)}]${media.extension}`,
            favorite,
            mediaType: "hls"
          };
        } catch (e) {
          // Do not expose an entry that cannot faithfully behave as one file.
          console.log(e)
          return null;
        }
      }));
    return entries.filter(Boolean);
  }

  async readdir(virtualPath = "/") {
    if (virtualPath !== "/") throw new Error("Not a directory.");
    return (await this.entries()).map(({ name, favorite }) => ({
      type: "file",
      name,
      createdAt: favorite.createdAt
    }));
  }

  async findFile(virtualPath) {
    if (!virtualPath.startsWith("/") || virtualPath.slice(1).includes("/")) return null;
    const name = virtualPath.slice(1);
    return (await this.entries()).find((entry) => entry.name === name) || null;
  }

  async stat(virtualPath) {
    if (virtualPath === "/") return { type: "directory", size: 0, createdAt: new Date(0).toISOString() };
    const entry = await this.findFile(virtualPath);
    if (!entry) return null;
    const media = entry.mediaType === "hls"
      ? await this.hlsPlaybackCache.statVirtualFile(entry.favorite.videoUrl)
      : await this.directPlaybackCache.stat(entry.favorite.videoUrl);
    return {
      type: "file",
      size: media.size,
      contentType: media.contentType,
      createdAt: entry.favorite.createdAt
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
