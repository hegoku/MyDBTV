const http = require("http");

function escapeXml(value) {
  return String(value || "").replace(/[<>&"']/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
  })[character]);
}

function normalizePath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value || "/");
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.split("/").some((part) => part === "..")) return null;
  return decoded === "/" ? "/" : decoded.replace(/\/+$/, "");
}

function parseRange(value, total) {
  if (!value) return { start: 0, end: total - 1, partial: false };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const start = match[1] === "" ? Math.max(0, total - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? total - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1), partial: true };
}

function hasValidBasicAuth(req, auth) {
  if (!auth?.username && !auth?.password) return true;
  const value = String(req.headers.authorization || "");
  if (!value.startsWith("Basic ")) return false;
  return Buffer.from(value.slice(6), "base64").toString("utf8") === `${auth.username}:${auth.password}`;
}

function sendDavError(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function propResponse(href, entry) {
  const modified = new Date(entry.createdAt || 0).toUTCString();
  const resourceType = entry.type === "directory" ? "<D:collection/>" : "";
  const length = entry.type === "file" ? `<D:getcontentlength>${entry.size}</D:getcontentlength>` : "";
  const contentType = entry.contentType ? `<D:getcontenttype>${escapeXml(entry.contentType)}</D:getcontenttype>` : "";
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop><D:resourcetype>${resourceType}</D:resourcetype>${length}${contentType}<D:getlastmodified>${modified}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function createWebDavServer({ fileSystem, auth }) {
  return http.createServer(async (req, res) => {
    if (!hasValidBasicAuth(req, auth)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="MyTV Favorites"' });
      res.end();
      return;
    }

    const virtualPath = normalizePath(new URL(req.url, "http://localhost").pathname);
    if (!virtualPath) return sendDavError(res, 400, "Invalid path.");

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { allow: "OPTIONS, PROPFIND, GET, HEAD", dav: "1", "ms-author-via": "DAV" });
        return res.end();
      }

      if (req.method === "PROPFIND") {
        const entry = await fileSystem.stat(virtualPath);
        if (!entry) return sendDavError(res, 404, "Not found.");
        const baseHref = encodeURI(virtualPath === "/" ? "/" : `${virtualPath}/`);
        const responses = [propResponse(baseHref, entry)];
        if (entry.type === "directory" && String(req.headers.depth || "infinity") !== "0") {
          const children = await fileSystem.readdir(virtualPath);
          for (const child of children) {
            const childPath = `/${child.name}`;
            const childStat = Number.isSafeInteger(child.size) ? child : await fileSystem.stat(childPath);
            if (childStat) responses.push(propResponse(encodeURI(childPath), childStat));
          }
        }
        const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
        res.writeHead(207, { "content-type": "application/xml; charset=utf-8", "content-length": Buffer.byteLength(body) });
        return res.end(body);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const entry = await fileSystem.stat(virtualPath);
        if (!entry) return sendDavError(res, 404, "Not found.");
        if (entry.type !== "file") return sendDavError(res, 405, "Directories cannot be downloaded.");
        const range = parseRange(req.headers.range, entry.size);
        if (!range) {
          res.writeHead(416, { "content-range": `bytes */${entry.size}`, "accept-ranges": "bytes" });
          return res.end();
        }
        const length = range.end - range.start + 1;
        const headers = { "content-type": entry.contentType || "application/octet-stream", "content-length": length, "accept-ranges": "bytes", "cache-control": "no-store" };
        if (range.partial) headers["content-range"] = `bytes ${range.start}-${range.end}/${entry.size}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        if (req.method === "HEAD") return res.end();
        const buffer = await fileSystem.read(virtualPath, range.start, length);
        return res.end(buffer);
      }

      return sendDavError(res, 405, "This is a read-only WebDAV library.");
    } catch (error) {
      return sendDavError(res, 502, error.message || "Unable to read media.");
    }
  });
}

module.exports = { createWebDavServer };
