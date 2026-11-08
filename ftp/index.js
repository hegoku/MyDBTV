const net = require("net");
const os = require("os");
const path = require("path");

const INITIAL_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

function getLanIpv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    const isVirtual = /virtual|vbox|vmnet|vethernet|loopback|pseudo/i.test(name);
    for (const item of nets[name]) {
      if (item.family === "IPv4" && !item.internal) {
        if (!isVirtual) {
          return item.address;
        }
        candidates.push(item.address);
      }
    }
  }
  return candidates[0] || "127.0.0.1";
}

function cleanIp(ip) {
  if (!ip) return null;
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip.includes(":")) return null;
  if (ip === "0.0.0.0") return null;
  return ip;
}

function formatUnixListEntry(name, size, date) {
  const d = new Date(date || 0);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, " ");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const mins = String(d.getUTCMinutes()).padStart(2, "0");
  const timeOrYear = hours + ":" + mins;
  return "-rw-r--r-- 1 owner group " + String(size).padStart(12, " ") + " " + month + " " + day + " " + timeOrYear + " " + name + "\r\n";
}

function formatMlsdEntry(name, size, date) {
  const d = new Date(date || 0);
  const pad = (n) => String(n).padStart(2, "0");
  const ts = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  return "type=file;size=" + size + ";modify=" + ts + "; " + name + "\r\n";
}

function formatMdtm(date) {
  const d = new Date(date || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
}

function normalizeVirtualPath(cwd, arg) {
  let target = (arg || "").trim().replace(/^"|"$/g, "");
  if (!target) return cwd;
  try {
    target = decodeURIComponent(target);
  } catch {}
  let resolved = target.startsWith("/") ? path.posix.normalize(target) : path.posix.normalize(path.posix.join(cwd, target));
  if (!resolved.startsWith("/")) resolved = "/" + resolved;
  return resolved;
}

class FtpConnection {
  constructor({ socket, fileSystem, auth, pasvHost }) {
    this.id = Math.random().toString(36).slice(2, 7);
    this.socket = socket;
    this.fileSystem = fileSystem;
    this.auth = auth;
    this.pasvHost = pasvHost;
    this.cwd = "/";
    this.user = null;
    this.authenticated = !auth;
    this.transferType = "I";
    this.restOffset = 0;
    this.pasvServer = null;
    this.activePortTarget = null;
    this.dataSocket = null;
    this.dataSocketPromise = null;
    this.dataSocketResolve = null;
    this.activeTransferAbort = null;

    this.socket.setEncoding("utf8");
    this.buffer = "";

    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => this.destroy());
    this.socket.on("error", () => this.destroy());

    this.reply(220, "MyTV Favorites Read-Only FTP Service Ready.");
  }

  reply(code, text) {
    if (this.socket.destroyed) return;
    console.log(`[FTP ${this.id}] > ${code} ${text}`);
    this.socket.write(code + " " + text + "\r\n");
  }

  destroy() {
    if (this.activeTransferAbort) {
      try { this.activeTransferAbort.abort(); } catch {}
      this.activeTransferAbort = null;
    }
    this.closePasvServer();
    if (this.dataSocket && !this.dataSocket.destroyed) {
      this.dataSocket.destroy();
    }
    this.dataSocket = null;
  }

  closePasvServer() {
    if (this.pasvServer) {
      try { this.pasvServer.close(); } catch {}
      this.pasvServer = null;
    }
    if (this.dataSocket) {
      if (!this.dataSocket.destroyed) {
        try { this.dataSocket.destroy(); } catch {}
      }
      this.dataSocket = null;
    }
    this.dataSocketPromise = null;
    this.dataSocketResolve = null;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        console.log(`[FTP ${this.id}] < ${line}`);
        this.handleCommand(line);
      }
    }
  }

  async handleCommand(line) {
    const space = line.indexOf(" ");
    const cmd = (space === -1 ? line : line.slice(0, space)).toUpperCase();
    const arg = space === -1 ? "" : line.slice(space + 1).trim();

    try {
      switch (cmd) {
        case "USER":
          this.user = arg;
          if (!this.auth) {
            this.authenticated = true;
            return this.reply(230, "User logged in, proceed.");
          }
          return this.reply(331, "User name okay, need password.");

        case "PASS":
          if (!this.auth) {
            this.authenticated = true;
            return this.reply(230, "User logged in, proceed.");
          }
          if (this.user === this.auth.username && arg === this.auth.password) {
            this.authenticated = true;
            return this.reply(230, "User logged in, proceed.");
          }
          this.authenticated = false;
          return this.reply(530, "Authentication failed.");

        case "SYST":
          return this.reply(215, "UNIX Type: L8");

        case "FEAT":
          return this.socket.write(["211-Features:", " SIZE", " MDTM", " REST STREAM", " PASV", " EPSV", " EPRT", " MLSD", " UTF8", "211 End"].join("\r\n") + "\r\n");

        case "OPTS":
          return this.reply(200, "OPTS OK.");

        case "NOOP":
          return this.reply(200, "OK.");

        case "QUIT":
          this.reply(221, "Goodbye.");
          return this.socket.end();

        case "TYPE":
          this.transferType = arg.toUpperCase();
          return this.reply(200, "Type set to " + this.transferType + ".");

        case "PWD":
        case "XPWD":
          return this.reply(257, '"' + this.cwd + '" is current directory.');

        case "CWD":
        case "XCWD":
        case "CDUP":
          this.cwd = "/";
          return this.reply(250, "Directory changed to /");

        case "PORT": {
          this.closePasvServer();
          const parts = arg.split(",").map(Number);
          if (parts.length !== 6 || parts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 255)) {
            return this.reply(501, "Invalid PORT command.");
          }
          const host = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
          const port = parts[4] * 256 + parts[5];
          this.activePortTarget = { host, port };
          return this.reply(200, "PORT command successful.");
        }

        case "EPRT": {
          this.closePasvServer();
          const parts = arg.split("|");
          if (parts.length >= 4) {
            const host = parts[2];
            const port = Number(parts[3]);
            if (host && Number.isSafeInteger(port) && port > 0) {
              this.activePortTarget = { host, port };
              return this.reply(200, "EPRT command successful.");
            }
          }
          return this.reply(501, "Invalid EPRT command.");
        }

        case "PASV":
          return this.handlePasv();

        case "EPSV":
          return this.handleEpsv();

        case "SIZE": {
          const target = normalizeVirtualPath(this.cwd, arg);
          const stat = await this.fileSystem.stat(target);
          if (!stat || stat.type !== "file") return this.reply(550, "File not found.");
          return this.reply(213, String(stat.size));
        }

        case "MLST": {
          const target = normalizeVirtualPath(this.cwd, arg);
          const stat = await this.fileSystem.stat(target);
          if (!stat) return this.reply(550, "File not found.");
          const isDir = stat.type === "directory";
          const d = new Date(stat.createdAt || 0);
          const pad = (n) => String(n).padStart(2, "0");
          const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
          const fact = isDir
            ? `type=dir;modify=${ts};perm=el; ${target}`
            : `type=file;size=${stat.size};modify=${ts};perm=r; ${target}`;
          console.log(`[FTP ${this.id}] > 250-MLST: ${fact}`);
          this.socket.write(`250-Begin\r\n ${fact}\r\n250 End.\r\n`);
          return;
        }

        case "MDTM": {
          const target = normalizeVirtualPath(this.cwd, arg);
          const stat = await this.fileSystem.stat(target);
          if (!stat || stat.type !== "file") return this.reply(550, "File not found.");
          return this.reply(213, formatMdtm(stat.createdAt));
        }

        case "REST": {
          const offset = Number(arg);
          if (Number.isSafeInteger(offset) && offset >= 0) {
            this.restOffset = offset;
            return this.reply(350, "Restarting at " + offset + ". Send RETR to initiate transfer.");
          }
          return this.reply(501, "Invalid offset.");
        }

        case "LIST":
        case "NLST":
        case "MLSD":
          return this.handleList(cmd);

        case "RETR":
          return this.handleRetr(arg);

        case "ABOR":
          if (this.activeTransferAbort) {
            this.activeTransferAbort.abort();
            this.activeTransferAbort = null;
          }
          if (this.dataSocket && !this.dataSocket.destroyed) this.dataSocket.destroy();
          this.dataSocket = null;
          return this.reply(226, "Abort successful.");

        default:
          return this.reply(502, "Command not implemented.");
      }
    } catch (err) {
      return this.reply(550, err.message || "Action failed.");
    }
  }

  async handlePasv() {
    this.closePasvServer();
    this.activePortTarget = null;

    const pasvServer = net.createServer();
    this.pasvServer = pasvServer;

    this.dataSocketPromise = new Promise((resolve) => {
      this.dataSocketResolve = resolve;
      pasvServer.once("connection", (dataSocket) => {
        this.dataSocket = dataSocket;
        resolve(dataSocket);
      });
    });

    await new Promise((resolve) => pasvServer.listen(0, "0.0.0.0", resolve));
    const port = pasvServer.address().port;

    let host = this.pasvHost || cleanIp(this.socket.localAddress) || getLanIpv4();
    const parts = host.split(".");
    const p1 = Math.floor(port / 256);
    const p2 = port % 256;
    this.reply(227, "Entering Passive Mode (" + parts.join(",") + "," + p1 + "," + p2 + ")");
  }

  async handleEpsv() {
    this.closePasvServer();
    this.activePortTarget = null;

    const pasvServer = net.createServer();
    this.pasvServer = pasvServer;

    this.dataSocketPromise = new Promise((resolve) => {
      this.dataSocketResolve = resolve;
      pasvServer.once("connection", (dataSocket) => {
        this.dataSocket = dataSocket;
        resolve(dataSocket);
      });
    });

    await new Promise((resolve) => pasvServer.listen(0, "0.0.0.0", resolve));
    const port = pasvServer.address().port;
    this.reply(229, "Entering Extended Passive Mode (|||" + port + "|)");
  }

  async getDataSocket() {
    if (this.activePortTarget) {
      const { host, port } = this.activePortTarget;
      this.activePortTarget = null;
      return new Promise((resolve, reject) => {
        const s = net.createConnection({ host, port }, () => {
          this.dataSocket = s;
          resolve(s);
        });
        s.once("error", reject);
      });
    }

    if (this.dataSocket && !this.dataSocket.destroyed) return this.dataSocket;
    if (this.dataSocketPromise) {
      const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("Data connection timeout")), 15000));
      return Promise.race([this.dataSocketPromise, timer]);
    }
    throw new Error("No data connection established.");
  }

  async handleList(cmd) {
    let dataSocket;
    try {
      this.reply(150, "Opening ASCII mode data connection for file list.");
      dataSocket = await this.getDataSocket();
    } catch {
      this.closePasvServer();
      return this.reply(425, "Can't open data connection.");
    }

    try {
      const items = await this.fileSystem.readdir("/");
      let output = "";
      for (const item of items) {
        if (cmd === "MLSD") {
          output += formatMlsdEntry(item.name, item.size, item.createdAt);
        } else if (cmd === "NLST") {
          output += item.name + "\r\n";
        } else {
          output += formatUnixListEntry(item.name, item.size, item.createdAt);
        }
      }
      dataSocket.write(output);
      dataSocket.end();
      this.closePasvServer();
      return this.reply(226, "Transfer complete.");
    } catch {
      if (dataSocket && !dataSocket.destroyed) dataSocket.destroy();
      this.closePasvServer();
      return this.reply(550, "Failed to read directory.");
    }
  }

  async handleRetr(arg) {
    const target = normalizeVirtualPath(this.cwd, arg);
    const stat = await this.fileSystem.stat(target);
    if (!stat || stat.type !== "file") {
      console.error("[FTP RETR 550 Not Found]", target);
      this.closePasvServer();
      return this.reply(550, "File not found.");
    }

    let dataSocket;
    try {
      this.reply(150, "Opening BINARY mode data connection (" + stat.size + " bytes).");
      dataSocket = await this.getDataSocket();
    } catch {
      this.closePasvServer();
      return this.reply(425, "Can't open data connection.");
    }

    const abortController = new AbortController();
    this.activeTransferAbort = abortController;

    let offset = this.restOffset;
    this.restOffset = 0;
    const totalSize = stat.size;

    const onClose = () => { abortController.abort(); };
    dataSocket.once("close", onClose);
    dataSocket.once("error", onClose);

    let chunkSize = INITIAL_CHUNK_SIZE;
    try {
      while (offset < totalSize && !abortController.signal.aborted && !dataSocket.destroyed) {
        const readLen = Math.min(chunkSize, totalSize - offset);
        const buffer = await this.fileSystem.read(target, offset, readLen);
        if (abortController.signal.aborted || dataSocket.destroyed) break;
        if (!buffer || buffer.length === 0) break;

        const canContinue = dataSocket.write(buffer);
        offset += buffer.length;

        if (chunkSize < MAX_CHUNK_SIZE) {
          chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize * 2);
        }

        if (!canContinue && !dataSocket.destroyed && !abortController.signal.aborted) {
          await new Promise((resolve) => {
            let done = false;
            const onUnblock = () => {
              if (!done) {
                done = true;
                dataSocket.removeListener("drain", onUnblock);
                dataSocket.removeListener("close", onUnblock);
                dataSocket.removeListener("error", onUnblock);
                abortController.signal.removeEventListener("abort", onUnblock);
                resolve();
              }
            };
            dataSocket.once("drain", onUnblock);
            dataSocket.once("close", onUnblock);
            dataSocket.once("error", onUnblock);
            abortController.signal.addEventListener("abort", onUnblock, { once: true });
          });
        }
      }

      dataSocket.removeListener("close", onClose);
      dataSocket.removeListener("error", onClose);

      const wasAborted = abortController.signal.aborted || dataSocket.destroyed;
      this.closePasvServer();
      this.activeTransferAbort = null;

      if (wasAborted) {
        console.log(`[FTP ${this.id}] Transfer aborted / client seeked at offset ${offset}/${totalSize}.`);
        if (!this.socket.destroyed) {
          this.reply(426, "Transfer aborted.");
        }
        return;
      }

      dataSocket.end();
      console.log(`[FTP ${this.id}] Transfer completed at offset ${offset}/${totalSize}.`);
      if (!this.socket.destroyed) {
        this.reply(226, "Transfer complete.");
      }
      return;
    } catch (err) {
      console.error("[FTP RETR Error]", err);
      dataSocket.removeListener("close", onClose);
      dataSocket.removeListener("error", onClose);
      if (!dataSocket.destroyed) dataSocket.destroy();
      this.closePasvServer();
      this.activeTransferAbort = null;
      return this.reply(552, "Transfer failed.");
    }
  }
}

function createFtpServer({ fileSystem, auth, pasvHost }) {
  const server = net.createServer((socket) => {
    new FtpConnection({ socket, fileSystem, auth, pasvHost });
  });
  return server;
}

module.exports = { createFtpServer };
