const path = require("path");
const { DirectFileDownloader } = require("./direct-file-downloader");
const { HlsDownloader } = require("./hls-downloader");

function detectDownloadType(file) {
  const url = String(file?.url || "");
  const format = String(file?.format || "");
  if (/\.m3u8(?:[?#]|$)/i.test(url) || /\bHLS\b/i.test(format)) return "hls";
  return "direct";
}

function outputExtensionFor(file) {
  const type = detectDownloadType(file);
  if (type === "hls") return ".ts";

  try {
    const ext = path.extname(new URL(file.url).pathname);
    return ext || ".bin";
  } catch {
    return path.extname(file.name || "") || ".bin";
  }
}

function createDownloader(job) {
  if (job.type === "hls") return new HlsDownloader(job);
  if (job.type === "direct") return new DirectFileDownloader(job);
  throw new Error(`No downloader is available for ${job.type}.`);
}

module.exports = {
  createDownloader,
  detectDownloadType,
  outputExtensionFor
};
