const fs = require("fs");
const path = require("path");
const { DownloadStore } = require("./download-store");
const { createDownloader, detectDownloadType, outputExtensionFor } = require("./downloaders");
const { normalizeConcurrency } = require("./downloaders/base-downloader");

function sanitizeFileName(name) {
  return String(name || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180);
}

function ensureSafePath(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error("Unsafe download path.");
  }
  return resolvedTarget;
}

function serializeJob(job) {
  return {
    id: job.id,
    title: job.title,
    fileName: job.fileName,
    format: job.format,
    type: job.type,
    url: job.url,
    status: job.status,
    received: job.received,
    total: job.total,
    segmentIndex: job.segmentIndex,
    segmentCount: job.segmentCount,
    pieceIndex: job.pieceIndex,
    pieceCount: job.pieceCount,
    concurrency: job.concurrency,
    path: job.path,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

class DownloadManager {
  constructor({ downloadDir }) {
    this.downloadDir = downloadDir;
    this.store = new DownloadStore({ filePath: path.join(downloadDir, "downloads.sqlite") });
    this.jobs = new Map();
    this.downloaders = new Map();
    this.loadPersistedJobs();
  }

  attachStore(job) {
    Object.defineProperty(job, "store", {
      value: this.store,
      enumerable: false,
      configurable: true
    });
    return job;
  }

  loadPersistedJobs() {
    for (const persisted of this.store.listJobs()) {
      const job = this.attachStore({
        ...persisted,
        pieces: this.store.getPieces(persisted.id)
      });
      if (["queued", "downloading"].includes(job.status)) {
        job.status = "paused";
        job.error = "Interrupted before completion. Resume to continue.";
        job.updatedAt = new Date().toISOString();
        this.store.saveJob(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  list() {
    return [...this.jobs.values()]
      .map(serializeJob)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? serializeJob(job) : null;
  }

  create({ item, file }) {
    if (!file?.url || !/^https?:\/\//i.test(file.url)) {
      throw new Error("A downloadable HTTP media URL is required.");
    }

    const existing = [...this.jobs.values()].find((job) => job.url === file.url);
    if (existing) {
      return serializeJob(existing);
    }

    fs.mkdirSync(this.downloadDir, { recursive: true });

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const type = detectDownloadType(file);
    const extension = outputExtensionFor(file);
    const baseName = sanitizeFileName(`${item?.title || "video"}-${file.name || "media"}`);
    const outputName = `${path.parse(baseName).name}-${id.slice(-8)}${extension}`;
    const targetPath = ensureSafePath(this.downloadDir, path.join(this.downloadDir, outputName));
    const now = new Date().toISOString();
    const job = this.attachStore({
      id,
      title: item?.title || file.name || "Video",
      fileName: file.name || outputName,
      format: file.format || "",
      type,
      url: file.url,
      status: "queued",
      received: 0,
      total: Number(file.size || 0),
      segmentIndex: 0,
      segmentCount: 0,
      pieceIndex: 0,
      pieceCount: 0,
      concurrency: normalizeConcurrency(file.concurrency),
      pieces: [],
      path: targetPath,
      error: "",
      createdAt: now,
      updatedAt: now
    });

    this.jobs.set(id, job);
    this.store.saveJob(job);
    this.start(job);
    return serializeJob(job);
  }

  start(job) {
    const downloader = createDownloader(job);
    this.downloaders.set(job.id, downloader);
    downloader.start().catch((error) => {
      if (job.status === "paused" || job.status === "deleted") return;
      job.status = "error";
      job.error = error.name === "AbortError" ? "Download was interrupted." : error.message;
      job.updatedAt = new Date().toISOString();
    });
  }

  pause(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (["complete", "error", "deleted"].includes(job.status)) return serializeJob(job);
    const downloader = this.downloaders.get(id);
    if (downloader) downloader.pause();
    job.status = "paused";
    job.updatedAt = new Date().toISOString();
    this.store.saveJob(job);
    return serializeJob(job);
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!["paused", "error"].includes(job.status)) return serializeJob(job);
    job.status = "queued";
    job.error = "";
    job.updatedAt = new Date().toISOString();
    this.store.saveJob(job);
    this.start(job);
    return serializeJob(job);
  }

  delete(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const downloader = this.downloaders.get(id) || createDownloader(job);
    downloader.pause();
    downloader.deleteFiles();
    this.downloaders.delete(id);
    this.jobs.delete(id);
    this.store.deleteJob(id);
    return serializeJob({ ...job, status: "deleted" });
  }

  close() {
    this.store.close();
  }
}

module.exports = {
  DownloadManager
};
