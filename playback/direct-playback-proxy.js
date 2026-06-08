function sendRange(res, result) {
  res.writeHead(result.status, {
    "content-length": result.buffer.byteLength,
    "cache-control": "no-store",
    ...result.headers
  });
  res.end(result.buffer);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "cache-control": "no-store"
  });
  res.end();
}

class DirectPlaybackProxy {
  constructor({ cache }) {
    this.cache = cache;
  }

  async handleMedia(req, requestUrl, res) {
    const url = String(requestUrl.searchParams.get("url") || "");
    const closeIfAborted = () => {
      if (!res.writableEnded) this.cache.closeByUrl(url);
    };
    req.once("aborted", closeIfAborted);
    res.once("close", closeIfAborted);

    const result = await this.cache.readRange(url, req.headers.range || "");
    sendRange(res, result);
  }

  handleRelease(requestUrl, res) {
    const url = String(requestUrl.searchParams.get("url") || "");
    if (url) this.cache.closeByUrl(url);
    sendNoContent(res);
  }
}

module.exports = {
  DirectPlaybackProxy
};
