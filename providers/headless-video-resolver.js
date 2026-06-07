const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const VIDEO_URL_PATTERN = /\.(m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:[?#]|$)/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
      return;
    }
    const handler = handlers.get(message.method);
    if (handler) handler(message.params || {});
  });

  return {
    open() {
      return new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    },
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    on(method, handler) {
      handlers.set(method, handler);
    },
    close() {
      try {
        ws.close();
      } catch {
        // Best effort cleanup.
      }
    }
  };
}

async function waitForChrome(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await delay(200);
    }
  }
  throw new Error("Chrome did not expose DevTools in time.");
}

function makeMediaCandidate(url, source) {
  const ext = (String(url).match(/\.(m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:[?#]|$)/i) || [])[1] || "media";
  const format = ext.toLowerCase() === "m3u8"
    ? "HLS"
    : ext.toLowerCase() === "mpd"
      ? "DASH"
      : ext.toUpperCase();
  return {
    name: format,
    format,
    size: 0,
    url,
    source
  };
}

async function isReachableMediaUrl(url) {
  const tryFetch = async (options) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "user-agent": "mytv-legal-media-tool/1.0",
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      if (response.ok || response.status === 206) {
        try {
          await response.body?.cancel();
        } catch {
          // Ignore body cleanup errors.
        }
        return true;
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
    return false;
  };

  return await tryFetch({ method: "HEAD" }) || await tryFetch({ headers: { range: "bytes=0-0" } });
}

async function resolveVideoWithHeadlessBrowser(pageUrl, { timeoutMs = 18000 } = {}) {
  const chromePath = findChromeExecutable();
  if (!chromePath) return null;

  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mytv-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ], { stdio: "ignore" });

  let cdp = null;
  try {
    await waitForChrome(port, Math.min(timeoutMs, 5000));
    const tab = await getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    cdp = createCdp(tab.webSocketDebuggerUrl);
    await cdp.open();

    const networkUrls = new Set();
    cdp.on("Network.requestWillBeSent", (params) => {
      const url = params.request?.url || "";
      if (VIDEO_URL_PATTERN.test(url)) networkUrls.add(url);
    });
    cdp.on("Network.responseReceived", (params) => {
      const url = params.response?.url || "";
      if (VIDEO_URL_PATTERN.test(url)) networkUrls.add(url);
    });

    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: pageUrl });

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const runtime = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify(Array.from(document.querySelectorAll('video')).map((video) => ({
          src: video.currentSrc || video.src,
          readyState: video.readyState
        })))`,
        returnByValue: true
      });
      const videos = runtime.result?.value ? JSON.parse(runtime.result.value) : [];
      const loaded = videos.find((video) => VIDEO_URL_PATTERN.test(video.src) && video.readyState >= 1);
      const candidates = [...new Set([
        loaded?.src || "",
        ...networkUrls
      ])].filter((url) => VIDEO_URL_PATTERN.test(url));
      for (const candidate of candidates) {
        if (await isReachableMediaUrl(candidate)) {
          return makeMediaCandidate(candidate, "headless embedded player");
        }
      }
      await delay(500);
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await delay(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Chrome may keep a lock briefly; leaked temp profiles are harmless.
    }
  }

  return null;
}

module.exports = {
  resolveVideoWithHeadlessBrowser
};
