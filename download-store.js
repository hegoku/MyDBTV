const fs = require("fs");
const path = require("path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function rowToJob(row) {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    format: row.format,
    type: row.type,
    url: row.url,
    status: row.status,
    received: Number(row.received || 0),
    total: Number(row.total || 0),
    segmentIndex: Number(row.segment_index || 0),
    segmentCount: Number(row.segment_count || 0),
    pieceIndex: Number(row.piece_index || 0),
    pieceCount: Number(row.piece_count || 0),
    concurrency: Number(row.concurrency || 4),
    path: row.path,
    error: row.error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variantUrl: row.variant_url || ""
  };
}

function rowToPiece(row) {
  return {
    index: Number(row.piece_index),
    start: Number(row.start_byte),
    end: Number(row.end_byte),
    received: Number(row.received || 0),
    done: Boolean(row.done)
  };
}

class DownloadStore {
  constructor({ filePath }) {
    if (!DatabaseSync) {
      throw new Error("SQLite is not available in this Node.js runtime.");
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        segment_index INTEGER NOT NULL DEFAULT 0,
        segment_count INTEGER NOT NULL DEFAULT 0,
        piece_index INTEGER NOT NULL DEFAULT 0,
        piece_count INTEGER NOT NULL DEFAULT 0,
        concurrency INTEGER NOT NULL DEFAULT 4,
        path TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        variant_url TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS download_pieces (
        job_id TEXT NOT NULL,
        piece_index INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, piece_index),
        FOREIGN KEY (job_id) REFERENCES downloads(id) ON DELETE CASCADE
      );
    `);
  }

  saveJob(job) {
    this.db.prepare(`
      INSERT INTO downloads (
        id, title, file_name, format, type, url, status, received, total,
        segment_index, segment_count, piece_index, piece_count, concurrency,
        path, error, created_at, updated_at, variant_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        file_name = excluded.file_name,
        format = excluded.format,
        type = excluded.type,
        url = excluded.url,
        status = excluded.status,
        received = excluded.received,
        total = excluded.total,
        segment_index = excluded.segment_index,
        segment_count = excluded.segment_count,
        piece_index = excluded.piece_index,
        piece_count = excluded.piece_count,
        concurrency = excluded.concurrency,
        path = excluded.path,
        error = excluded.error,
        updated_at = excluded.updated_at,
        variant_url = excluded.variant_url
    `).run(
      job.id,
      job.title,
      job.fileName,
      job.format || "",
      job.type,
      job.url,
      job.status,
      Math.floor(job.received || 0),
      Math.floor(job.total || 0),
      Math.floor(job.segmentIndex || 0),
      Math.floor(job.segmentCount || 0),
      Math.floor(job.pieceIndex || 0),
      Math.floor(job.pieceCount || 0),
      Math.floor(job.concurrency || 4),
      job.path,
      job.error || "",
      job.createdAt,
      job.updatedAt,
      job.variantUrl || ""
    );
  }

  listJobs() {
    return this.db.prepare("SELECT * FROM downloads ORDER BY created_at DESC").all().map(rowToJob);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id);
    return row ? rowToJob(row) : null;
  }

  deleteJob(id) {
    this.db.prepare("DELETE FROM download_pieces WHERE job_id = ?").run(id);
    this.db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
  }

  replacePieces(jobId, pieces) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM download_pieces WHERE job_id = ?").run(jobId);
      const insert = this.db.prepare(`
        INSERT INTO download_pieces (job_id, piece_index, start_byte, end_byte, received, done, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const piece of pieces || []) {
        insert.run(jobId, piece.index, piece.start, piece.end, piece.received || 0, piece.done ? 1 : 0, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  savePiece(jobId, piece) {
    this.db.prepare(`
      INSERT INTO download_pieces (job_id, piece_index, start_byte, end_byte, received, done, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, piece_index) DO UPDATE SET
        start_byte = excluded.start_byte,
        end_byte = excluded.end_byte,
        received = excluded.received,
        done = excluded.done,
        updated_at = excluded.updated_at
    `).run(
      jobId,
      piece.index,
      piece.start,
      piece.end,
      Math.floor(piece.received || 0),
      piece.done ? 1 : 0,
      new Date().toISOString()
    );
  }

  getPieces(jobId) {
    return this.db
      .prepare("SELECT * FROM download_pieces WHERE job_id = ? ORDER BY piece_index ASC")
      .all(jobId)
      .map(rowToPiece);
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  DownloadStore
};
