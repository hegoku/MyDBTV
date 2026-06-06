const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 5177);
const MAX_PORT_ATTEMPTS = 20;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const { providers, providerRegistry } = require("./providers");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const downloadJobs = new Map();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sanitizeFileName(name) {
  return String(name || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180);
}

function parseExternalId(identifier) {
  return providerRegistry.parseIdentifier(identifier);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function searchSourceProvider(provider, query, page) {
  return provider.search(query, page);
}

async function searchCombined(requestUrl) {
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const query = String(requestUrl.searchParams.get("q") || "").trim();
  const selectedSource = requestUrl.searchParams.get("source") || "all";
  const selectedProviders = selectedSource === "all"
    ? providers
    : providers.filter((provider) => provider.id === selectedSource);
  const tasks = selectedProviders.map((provider) => searchSourceProvider(provider, query, page));

  const settled = await Promise.allSettled(tasks);
  const payloads = settled.map((result) => {
    if (result.status === "fulfilled") return result.value;
    return { provider: "Unknown", page, total: 0, results: [], error: result.reason?.message || "Search failed." };
  });
  const results = payloads.flatMap((payload) => payload.results || []);
  const errors = payloads.filter((payload) => payload.error).map((payload) => `${payload.provider}: ${payload.error}`);

  return {
    provider: "Combined",
    page,
    total: results.length,
    results,
    sources: payloads.map((payload) => ({
      provider: payload.provider,
      total: payload.total || 0,
      error: payload.error || ""
    })),
    warnings: errors
  };
}

async function getProviderItem(identifier) {
  const parsed = parseExternalId(identifier);
  if (!parsed) throw new Error("Invalid item identifier.");
  return parsed.provider.getItem(parsed.sourceUrl);
}

async function getSourceMedia(sourceUrl) {
  const provider = providerRegistry.findByUrl(sourceUrl);
  if (!provider) {
    throw new Error("No provider is configured for this source URL.");
  }
  return provider.resolveMedia(sourceUrl);
}

async function getItem(identifier) {
  return getProviderItem(identifier);
}

async function startDownload(identifier, fileName) {
  const parsed = parseExternalId(identifier);
  if (!parsed || !parsed.provider.getDownloadFile) {
    throw new Error("Downloads are not available for this provider.");
  }
  const { item, file } = await parsed.provider.getDownloadFile(parsed.sourceUrl, fileName);

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeName = sanitizeFileName(`${item.title}-${path.basename(file.name)}`);
  const targetPath = path.join(DOWNLOAD_DIR, safeName);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep)) {
    throw new Error("Unsafe download path.");
  }

  const job = {
    id: jobId,
    title: item.title,
    fileName: file.name,
    status: "queued",
    received: 0,
    total: file.size || 0,
    path: resolvedTarget,
    error: ""
  };
  downloadJobs.set(jobId, job);

  runDownloadJob(job, file.url).catch((error) => {
    job.status = "error";
    job.error = error.message;
  });

  return job;
}

async function runDownloadJob(job, url) {
  job.status = "downloading";
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "mytv-legal-media-tool/1.0" }
    });
  } catch {
    throw new Error("Could not reach the media file. Check network access and try again.");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with ${response.status}.`);
  }

  job.total = Number(response.headers.get("content-length") || job.total || 0);
  const tempPath = `${job.path}.part`;
  const fileStream = fs.createWriteStream(tempPath);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      job.received += value.byteLength;
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise((resolve) => fileStream.once("drain", resolve));
      }
    }
  } finally {
    fileStream.end();
  }

  await new Promise((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });

  fs.renameSync(tempPath, job.path);
  job.status = "complete";
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  });
}

async function route(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/providers") {
      sendJson(res, 200, {
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name
        }))
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/search") {
      sendJson(res, 200, await searchCombined(requestUrl));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/item/")) {
      const identifier = decodeURIComponent(pathname.replace("/api/item/", ""));
      sendJson(res, 200, await getItem(identifier));
      return;
    }

    if (req.method === "GET" && pathname === "/api/source-media") {
      const sourceUrl = String(requestUrl.searchParams.get("url") || "");
      sendJson(res, 200, await getSourceMedia(sourceUrl));
      return;
    }

    if (req.method === "POST" && pathname === "/api/downloads") {
      const body = await readJsonBody(req);
      const job = await startDownload(String(body.identifier || ""), String(body.fileName || ""));
      sendJson(res, 202, job);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/downloads/")) {
      const jobId = decodeURIComponent(pathname.replace("/api/downloads/", ""));
      const job = downloadJobs.get(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Download job not found." });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error." });
  }
}

function listen(port, attemptsLeft = MAX_PORT_ATTEMPTS) {
  const server = http.createServer(route);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(error.message);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(`MyTV Legal Media Tool running at http://localhost:${port}`);
  });
}

listen(PORT);
