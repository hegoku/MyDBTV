const fs = require("fs");
const { BaseDownloader, finishStream } = require("./base-downloader");

const PIECE_SIZE = 4 * 1024 * 1024;

function parseContentRange(value) {
  const match = String(value || "").match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match || match[3] === "*") return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3])
  };
}

function makePieces(total) {
  const pieces = [];
  for (let start = 0, index = 0; start < total; start += PIECE_SIZE, index += 1) {
    pieces.push({
      index,
      start,
      end: Math.min(start + PIECE_SIZE - 1, total - 1),
      received: 0,
      done: false,
      active: false,
      dirty: true
    });
  }
  return pieces;
}

function normalizePieces(pieces, total) {
  if (!Array.isArray(pieces) || !pieces.length) return null;
  const normalized = pieces.map((piece) => ({
    index: Number(piece.index),
    start: Number(piece.start),
    end: Number(piece.end),
    received: Number(piece.received || 0),
    done: Boolean(piece.done),
    active: false
  }));
  const valid = normalized.every((piece, index) => (
    piece.index === index &&
    Number.isSafeInteger(piece.start) &&
    Number.isSafeInteger(piece.end) &&
    piece.start <= piece.end &&
    piece.end < total &&
    piece.received >= 0 &&
    piece.received <= piece.end - piece.start + 1
  ));
  return valid ? normalized : null;
}

async function writeAt(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    offset += result.bytesWritten;
  }
}

class DirectFileDownloader extends BaseDownloader {
  async start() {
    this.job.status = "downloading";
    this.job.error = "";
    this.touch();
    this.persistState();

    const probe = await this.probeRangeSupport();
    if (!probe.supportsRange || !probe.total) {
      await this.startSingleConnection(probe.total);
      return;
    }

    await this.startParallelRanges(probe.total);
  }

  async probeRangeSupport() {
    const headController = this.makeAbortController();
    try {
      const response = await fetch(this.job.url, {
        method: "HEAD",
        headers: { "user-agent": "mytv-legal-media-tool/1.0" },
        signal: headController.signal
      });
      if (response.ok) {
        const total = Number(response.headers.get("content-length") || 0);
        const supportsRange = /\bbytes\b/i.test(response.headers.get("accept-ranges") || "");
        if (total && supportsRange) return { supportsRange: true, total };
      }
    } catch {
      // Some servers reject HEAD. A small range probe follows.
    } finally {
      this.releaseAbortController(headController);
    }

    const rangeController = this.makeAbortController();
    try {
      const response = await fetch(this.job.url, {
        headers: {
          range: "bytes=0-0",
          "user-agent": "mytv-legal-media-tool/1.0"
        },
        signal: rangeController.signal
      });
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get("content-range"));
        await response.arrayBuffer();
        if (range?.total) return { supportsRange: true, total: range.total };
      }
      const total = Number(response.headers.get("content-length") || 0);
      return { supportsRange: false, total };
    } finally {
      this.releaseAbortController(rangeController);
    }
  }

  async startParallelRanges(total) {
    this.job.total = total;
    const restoredPieces = normalizePieces(this.job.pieces, total);
    this.job.pieces = restoredPieces || makePieces(total);
    this.job.pieceCount = this.job.pieces.length;
    this.job.received = this.job.pieces.reduce((sum, piece) => sum + piece.received, 0);
    this.job.pieceIndex = this.job.pieces.filter((piece) => piece.done).length;
    this.touch();
    this.job.store?.replacePieces(this.job.id, this.job.pieces);
    this.persistState();

    fs.closeSync(fs.openSync(this.tempPath, "a"));
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, this.job.pieces.length) },
      async () => {
        while (!this.isStopped()) {
          const piece = this.nextPendingPiece(nextIndex);
          if (!piece) return;
          nextIndex = piece.index + 1;
          await this.downloadPiece(piece);
        }
      }
    );

    await Promise.all(workers);

    if (this.isStopped()) return;
    if (!this.job.pieces.every((piece) => piece.done)) {
      throw new Error("Direct download stopped before all pieces completed.");
    }

    fs.renameSync(this.tempPath, this.job.path);
    this.job.status = "complete";
    this.job.pieceIndex = this.job.pieceCount;
    this.job.received = total;
    this.touch();
    this.persistState();
  }

  nextPendingPiece(startIndex) {
    for (let index = startIndex; index < this.job.pieces.length; index += 1) {
      const piece = this.job.pieces[index];
      if (!piece.active && !piece.done && piece.received < piece.end - piece.start + 1) {
        piece.active = true;
        return piece;
      }
    }
    for (const piece of this.job.pieces) {
      if (!piece.active && !piece.done && piece.received < piece.end - piece.start + 1) {
        piece.active = true;
        return piece;
      }
    }
    return null;
  }

  async downloadPiece(piece) {
    const controller = this.makeAbortController();
    const handle = await fs.promises.open(this.tempPath, "r+");
    try {
      const from = piece.start + piece.received;
      const response = await fetch(this.job.url, {
        headers: {
          range: `bytes=${from}-${piece.end}`,
          "user-agent": "mytv-legal-media-tool/1.0"
        },
        signal: controller.signal
      });
      if (response.status !== 206 || !response.body) {
        throw new Error("The server did not honor a range request for direct download.");
      }

      const reader = response.body.getReader();
      while (!this.isStopped()) {
        const { value, done } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        const position = piece.start + piece.received;
        await writeAt(handle, buffer, position);
        piece.received += buffer.length;
        piece.dirty = true;
        this.job.received += buffer.length;
        this.touch();

        if (piece.received % (512 * 1024) < buffer.length) {
          this.persistState();
        }
      }

      if (this.isStopped()) return;
      if (piece.received !== piece.end - piece.start + 1) {
        throw new Error(`Range piece ${piece.index + 1} ended early.`);
      }
      piece.done = true;
      piece.dirty = true;
      this.job.pieceIndex = this.job.pieces.filter((candidate) => candidate.done).length;
      this.touch();
      this.persistState();
    } catch (error) {
      if (this.isStopped() || error.name === "AbortError") return;
      throw error;
    } finally {
      await handle.close();
      piece.active = false;
      this.releaseAbortController(controller);
    }
  }

  async startSingleConnection(total) {
    const existingSize = fs.existsSync(this.tempPath) ? fs.statSync(this.tempPath).size : 0;
    const headers = {
      "user-agent": "mytv-legal-media-tool/1.0"
    };
    if (existingSize > 0) headers.range = `bytes=${existingSize}-`;

    const controller = this.makeAbortController();
    let response;
    try {
      response = await fetch(this.job.url, {
        headers,
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`Download failed with ${response.status}.`);
      }

      const canResume = existingSize > 0 && response.status === 206;
      if (existingSize > 0 && !canResume) {
        fs.rmSync(this.tempPath, { force: true });
        this.job.received = 0;
      } else {
        this.job.received = existingSize;
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength) {
        this.job.total = canResume ? existingSize + contentLength : contentLength;
      } else if (total) {
        this.job.total = total;
      }
      this.job.pieceCount = 1;
      this.job.pieceIndex = 0;
      this.touch();
      this.persistState();

      const fileStream = fs.createWriteStream(this.tempPath, { flags: canResume ? "a" : "w" });
      const reader = response.body.getReader();

      try {
        while (!this.isStopped()) {
          const { value, done } = await reader.read();
          if (done) break;
          this.job.received += value.byteLength;
          this.touch();
          if (!fileStream.write(Buffer.from(value))) {
            await new Promise((resolve) => fileStream.once("drain", resolve));
          }
        }
      } finally {
        await finishStream(fileStream);
      }
    } finally {
      this.releaseAbortController(controller);
    }

    if (this.isStopped()) return;

    fs.renameSync(this.tempPath, this.job.path);
    this.job.status = "complete";
    this.job.pieceIndex = 1;
    this.touch();
    this.persistState();
  }
}

module.exports = {
  DirectFileDownloader
};
