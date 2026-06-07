const fs = require("fs");

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 12;

function writeBuffer(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    if (stream.write(buffer)) {
      stream.removeListener("error", reject);
      resolve();
      return;
    }
    stream.once("drain", () => {
      stream.removeListener("error", reject);
      resolve();
    });
  });
}

function finishStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(parsed)));
}

class BaseDownloader {
  constructor(job) {
    if (new.target === BaseDownloader) {
      throw new Error("BaseDownloader cannot be instantiated directly.");
    }
    this.job = job;
    this.abortControllers = new Set();
  }

  get tempPath() {
    return `${this.job.path}.part`;
  }

  get statePath() {
    return `${this.job.path}.state.json`;
  }

  get concurrency() {
    return normalizeConcurrency(this.job.concurrency);
  }

  makeAbortController() {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    return controller;
  }

  releaseAbortController(controller) {
    this.abortControllers.delete(controller);
  }

  isStopped() {
    return this.job.status === "paused" || this.job.status === "deleted";
  }

  async start() {
    throw new Error("Downloader subclasses must implement start().");
  }

  pause() {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    if (!["complete", "deleted"].includes(this.job.status)) {
      this.job.status = "paused";
      this.touch();
    }
  }

  deleteFiles() {
    for (const filePath of [this.job.path, this.tempPath, this.statePath]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Best effort cleanup. The job removal still succeeds.
      }
    }
  }

  touch() {
    this.job.updatedAt = new Date().toISOString();
  }

  persistState(extra = {}) {
    this.job.store?.saveJob({ ...this.job, ...extra });
    if (Array.isArray(this.job.pieces)) {
      for (const piece of this.job.pieces) {
        if (piece.dirty) {
          this.job.store?.savePiece(this.job.id, piece);
          piece.dirty = false;
        }
      }
    }

    try {
      fs.writeFileSync(this.statePath, JSON.stringify({
        id: this.job.id,
        type: this.job.type,
        url: this.job.url,
        received: this.job.received,
        total: this.job.total,
        segmentIndex: this.job.segmentIndex,
        segmentCount: this.job.segmentCount,
        pieceIndex: this.job.pieceIndex,
        pieceCount: this.job.pieceCount,
        pieces: this.job.pieces,
        updatedAt: this.job.updatedAt,
        ...extra
      }));
    } catch {
      // Progress state is best-effort; the in-memory job remains authoritative.
    }
  }
}

module.exports = {
  BaseDownloader,
  DEFAULT_CONCURRENCY,
  finishStream,
  normalizeConcurrency,
  writeBuffer
};
