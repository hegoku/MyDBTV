const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function rowToFavorite(row) {
  return {
    id: row.id,
    originalPageUrl: row.original_page_url,
    source: row.source,
    title: row.title,
    videoUrl: row.video_url,
    coverUrl: row.cover_url,
    createdAt: row.created_at
  };
}

function favoriteIdFor(originalPageUrl, videoUrl) {
  return crypto
    .createHash("sha256")
    .update(`${originalPageUrl}\n${videoUrl}`)
    .digest("base64url")
    .slice(0, 32);
}

class FavoriteStore {
  constructor({ filePath }) {
    if (!DatabaseSync) {
      throw new Error("SQLite is not available in this Node.js runtime.");
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        original_page_url TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        video_url TEXT NOT NULL,
        cover_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS favorites_page_video_unique
        ON favorites(original_page_url, video_url);
    `);
  }

  normalize(input) {
    const originalPageUrl = String(input.originalPageUrl || "").trim();
    const videoUrl = String(input.videoUrl || "").trim();
    if (!originalPageUrl) throw new Error("Original page URL is required.");
    if (!videoUrl) throw new Error("Video URL is required.");

    return {
      id: favoriteIdFor(originalPageUrl, videoUrl),
      originalPageUrl,
      source: String(input.source || "Unknown source").trim() || "Unknown source",
      title: String(input.title || "Untitled video").trim() || "Untitled video",
      videoUrl,
      coverUrl: String(input.coverUrl || "").trim(),
      createdAt: input.createdAt || new Date().toISOString()
    };
  }

  save(input) {
    const favorite = this.normalize(input);
    this.db.prepare(`
      INSERT INTO favorites (id, original_page_url, source, title, video_url, cover_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        original_page_url = excluded.original_page_url,
        source = excluded.source,
        title = excluded.title,
        video_url = excluded.video_url,
        cover_url = excluded.cover_url,
        created_at = favorites.created_at
    `).run(
      favorite.id,
      favorite.originalPageUrl,
      favorite.source,
      favorite.title,
      favorite.videoUrl,
      favorite.coverUrl,
      favorite.createdAt
    );
    return this.get(favorite.id);
  }

  list() {
    return this.db
      .prepare("SELECT * FROM favorites ORDER BY created_at DESC")
      .all()
      .map(rowToFavorite);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM favorites WHERE id = ?").get(id);
    return row ? rowToFavorite(row) : null;
  }

  delete(id) {
    const favorite = this.get(id);
    if (!favorite) return null;
    this.db.prepare("DELETE FROM favorites WHERE id = ?").run(id);
    return favorite;
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  FavoriteStore
};
