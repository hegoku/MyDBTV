const { createApp } = Vue;
const MEDIA_URL_PATTERN = /\.(m3u8|mp4|m4v|webm|ogv|mpd|flv)(?:[?#]|$)/i;

createApp({
  data() {
    return {
      queryInput: "",
      sourceInput: "all",
      query: "",
      source: "all",
      sourceOptions: [
        { value: "all", label: "All sources" }
      ],
      page: 1,
      total: 0,
      canGoNext: false,
      loading: false,
      detailLoading: false,
      error: "",
      results: [],
      selectedId: "",
      selectedItem: null,
      selectedFileIndex: 0,
      downloadJob: null,
      activeDetailDownloadId: "",
      downloadConcurrency: 4,
      downloads: [],
      downloadsLoading: false,
      downloadsError: "",
      downloadsTimer: null,
      selectedDownloadId: "",
      activeView: "search",
      downloadTimer: null,
      hls: null
    };
  },

  computed: {
    resultLabel() {
      if (this.loading) return "Searching";
      if (this.error) return "Search failed";
      if (!this.total) return "Ready";
      return `${this.total.toLocaleString()} results`;
    },

    sourceLabel() {
      return this.sourceOptions.find((option) => option.value === this.sourceInput)?.label || "All sources";
    },

    selectedFile() {
      if (!this.selectedItem || !this.selectedItem.files.length) return null;
      const file = this.selectedItem.files[this.selectedFileIndex] || null;
      if (!file) return null;
      return file;
    },

    playerUrl() {
      const url = this.selectedFile?.url || "";
      return MEDIA_URL_PATTERN.test(url) ? this.playbackUrlFor(url) : "";
    },

    embeddedPlayerUrl() {
      return this.selectedFile?.embedUrl || "";
    },

    externalPlayerUrl() {
      const file = this.selectedFile;
      if (!file || file.embedUrl || !file.url || file.resolvable || MEDIA_URL_PATTERN.test(String(file.url))) return "";
      return file.external || /^https?:\/\//i.test(String(file.url)) ? file.url : "";
    },

    detailMeta() {
      if (!this.selectedItem) return "";
      return this.itemMeta(this.selectedItem);
    },

    downloadBusy() {
      return this.downloadJob && ["resolving", "starting"].includes(this.downloadJob.status);
    },

    selectedFileDownload() {
      const url = this.selectedFile?.url || "";
      if (!url) return null;
      return this.downloads.find((job) => job.url === url) || null;
    },

    saveDisabled() {
      return !this.selectedFile || this.downloadBusy || Boolean(this.selectedFileDownload);
    },

    saveLabel() {
      return this.selectedFileDownload ? "Saved" : "Save";
    },

    downloadPercent() {
      if (!this.downloadJob || !this.downloadJob.total) return 0;
      return Math.min(100, Math.round((this.downloadJob.received / this.downloadJob.total) * 100));
    },

    downloadDetail() {
      if (!this.downloadJob) return "";
      if (this.downloadJob.total) {
        return `${this.formatBytes(this.downloadJob.received)} of ${this.formatBytes(this.downloadJob.total)}`;
      }
      return this.formatBytes(this.downloadJob.received);
    },

    selectedDownload() {
      return this.downloads.find((job) => job.id === this.selectedDownloadId) || this.downloads[0] || null;
    },

    downloadsLabel() {
      if (this.downloadsLoading) return "Loading";
      if (!this.downloads.length) return "No downloads";
      const active = this.downloads.filter((job) => ["queued", "downloading"].includes(job.status)).length;
      if (active) return `${active} active`;
      return `${this.downloads.length} saved`;
    }
  },

  watch: {
    selectedFile() {
      this.$nextTick(() => {
        const player = this.$refs.player;
        if (player) player.load();
      });
    },

    selectedFileIndex() {
      this.clearDetailDownloadPolling();
      this.resolveSelectedFile().catch((error) => {
        this.downloadJob = {
          status: "error",
          received: 0,
          total: 0,
          error: error.message
        };
      });
    }
  },

  mounted() {
    this.loadProviders();
    this.loadDownloads();
    this.downloadsTimer = window.setInterval(() => this.loadDownloads({ quiet: true }), 1200);
  },

    beforeUnmount() {
      if (this.downloadTimer) window.clearTimeout(this.downloadTimer);
    if (this.downloadsTimer) window.clearInterval(this.downloadsTimer);
    this.destroyHls();
    },

  methods: {
    clearDetailDownloadPolling() {
      this.activeDetailDownloadId = "";
      if (this.downloadTimer) {
        window.clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
    },

    async fetchJson(url, options) {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Request failed.");
      }
      return data;
    },

    formatBytes(size) {
      if (!size) return "Unknown size";
      const units = ["B", "KB", "MB", "GB"];
      let value = size;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
    },

    jobPercent(job) {
      if (!job) return 0;
      if (job.total) return Math.min(100, Math.round((job.received / job.total) * 100));
      if (job.segmentCount) return Math.min(100, Math.round((job.segmentIndex / job.segmentCount) * 100));
      return 0;
    },

    downloadDetailText(job) {
      if (!job) return "";
      const bytes = job.total
        ? `${this.formatBytes(job.received)} of ${this.formatBytes(job.total)}`
        : this.formatBytes(job.received);
      const segments = job.segmentCount ? ` - ${job.segmentIndex}/${job.segmentCount} segments` : "";
      const pieces = job.pieceCount ? ` - ${job.pieceIndex}/${job.pieceCount} pieces` : "";
      return `${bytes}${segments || pieces}`;
    },

    openDownloads() {
      this.activeView = "downloads";
      this.loadDownloads();
    },

    openSearch() {
      this.activeView = "search";
    },

    shortCreator(creator) {
      return String(creator || "").slice(0, 32);
    },

    itemMeta(item) {
      return [item?.year, item?.creator, item?.source]
        .filter(Boolean)
        .join(" - ");
    },

    resultSummary(item) {
      return this.itemMeta(item) || item.description || "No details available.";
    },

    async loadProviders() {
      try {
        const data = await this.fetchJson("/api/providers");
        this.sourceOptions = [
          { value: "all", label: "All sources" },
          ...data.providers.map((provider) => ({
            value: provider.id,
            label: provider.name
          }))
        ];
      } catch {
        this.sourceOptions = [{ value: "all", label: "All sources" }];
      }
    },

    async loadDownloads(options = {}) {
      if (!options.quiet) {
        this.downloadsLoading = true;
        this.downloadsError = "";
      }
      try {
        const data = await this.fetchJson("/api/downloads");
        this.downloads = data.downloads || [];
        if (this.selectedDownloadId && !this.downloads.some((job) => job.id === this.selectedDownloadId)) {
          this.selectedDownloadId = "";
        }
        if (!this.selectedDownloadId && this.downloads.length) {
          this.selectedDownloadId = this.downloads[0].id;
        }
      } catch (error) {
        if (!options.quiet) this.downloadsError = error.message;
      } finally {
        if (!options.quiet) this.downloadsLoading = false;
      }
    },

    submitSearch() {
      this.query = this.queryInput;
      this.source = this.sourceInput;
      this.page = 1;
      this.search();
    },

    changePage(delta) {
      this.page = Math.max(1, this.page + delta);
      this.search();
    },

    async search() {
      this.loading = true;
      this.error = "";
      this.canGoNext = false;

      const params = new URLSearchParams({
        q: this.query,
        source: this.source,
        page: String(this.page)
      });

      try {
        const data = await this.fetchJson(`/api/search?${params}`);
        this.results = data.results;
        this.total = data.total;
        if (!data.results.length && data.warnings?.length) {
          this.error = data.warnings.join(" | ");
        }
        this.canGoNext = data.results.length > 0;
      } catch (error) {
        this.error = error.message;
        this.results = [];
      } finally {
        this.loading = false;
      }
    },

    async loadItem(identifier) {
      this.selectedId = identifier;
      this.selectedItem = null;
      this.selectedFileIndex = 0;
      this.detailLoading = true;
      this.downloadJob = null;
      this.clearDetailDownloadPolling();

      try {
        this.selectedItem = await this.fetchJson(`/api/item/${encodeURIComponent(identifier)}`);
        try {
          await this.resolveSelectedFile();
        } catch (error) {
          this.downloadJob = {
            status: "error",
            received: 0,
            total: 0,
            error: error.message
          };
        }
      } catch (error) {
        this.selectedItem = {
          title: "Could not load item",
          description: error.message,
          files: [],
          poster: "",
          source: "",
          sourceUrl: "#"
        };
      } finally {
        this.detailLoading = false;
      }
    },

    isHlsUrl(url) {
      return /\.m3u8(?:[?#]|$)/i.test(String(url || ""));
    },

    isDirectPlaybackUrl(url) {
      return /\.(mp4|m4v|webm|ogv)(?:[?#]|$)/i.test(String(url || ""));
    },

    playbackUrlFor(url) {
      const mediaUrl = String(url || "");
      if (this.isHlsUrl(mediaUrl)) {
        const params = new URLSearchParams({ url: mediaUrl });
        return `/api/play/hls?${params}`;
      }
      if (this.isDirectPlaybackUrl(mediaUrl)) {
        const params = new URLSearchParams({ url: mediaUrl });
        return `/api/play/direct?${params}`;
      }
      return mediaUrl;
    },

    destroyHls() {
      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
    },

    playSelectedMedia() {
      this.$nextTick(() => {
        const player = this.$refs.player;
        const file = this.selectedFile;
        if (!player || !file) return;

        this.destroyHls();
        if (this.isHlsUrl(file.url) && window.Hls && window.Hls.isSupported()) {
          this.hls = new Hls();
          player.removeAttribute("src");
          this.hls.loadSource(this.playbackUrlFor(file.url));
          this.hls.attachMedia(player);
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            player.play().catch(() => {});
          });
          return;
        }

        player.src = this.playbackUrlFor(file.url);
        player.load();
        player.play().catch(() => {});
      });
    },

    async resolveSelectedFile() {
      const original = this.selectedItem?.files[this.selectedFileIndex];
      if (!original) return null;
      if (!original.resolvable || MEDIA_URL_PATTERN.test(String(original.url || ""))) return original;

      this.downloadJob = {
        status: "resolving",
        received: 0,
        total: 0,
        error: ""
      };

      const params = new URLSearchParams({ url: original.url });
      const data = await this.fetchJson(`/api/source-media?${params}`);
      const media = data.selected;
      if (!media) {
        throw new Error("No public media URL was found on this source page.");
      }

      const resolvedFile = {
        ...original,
        ...media,
        name: original.name || media.name,
        format: media.format || original.format,
        resolvedFrom: original.url
      };
      this.selectedItem.files.splice(this.selectedFileIndex, 1, resolvedFile);
      this.downloadJob = null;
      return resolvedFile;
    },

    async watchSelected() {
      if (!this.selectedFile) return;

      let file = this.selectedFile;
      if (this.selectedFile.resolvable) {
        try {
          file = await this.resolveSelectedFile();
        } catch (error) {
          this.downloadJob = {
            status: "unavailable",
            received: 0,
            total: 0,
            error: `${error.message} Open the source page if you have access there.`
          };
          window.open(this.selectedFile.url, "_blank", "noopener,noreferrer");
          return;
        }
      }

      if (!MEDIA_URL_PATTERN.test(String(file.url || ""))) {
        window.open(file.url, "_blank", "noopener,noreferrer");
        return;
      }

      this.playSelectedMedia();
    },

    async startDownload() {
      if (!this.selectedItem || !this.selectedFile) return;

      const existing = this.selectedFileDownload;
      if (existing) {
        this.selectedDownloadId = existing.id;
        this.activeView = "downloads";
        return;
      }

      let file = this.selectedFile;
      if (file.resolvable) {
        try {
          file = await this.resolveSelectedFile();
        } catch (error) {
          this.downloadJob = {
            status: "error",
            received: 0,
            total: 0,
            error: error.message
          };
          return;
        }
      }

      if (!MEDIA_URL_PATTERN.test(String(file.url || ""))) {
        this.downloadJob = {
          status: "error",
          received: 0,
          total: 0,
          error: "This selection is an external player page, not a direct media file."
        };
        return;
      }

      const resolvedExisting = this.downloads.find((job) => job.url === file.url);
      if (resolvedExisting) {
        this.selectedDownloadId = resolvedExisting.id;
        this.activeView = "downloads";
        return;
      }

      this.downloadJob = {
        status: "starting",
        received: 0,
        total: file.size || 0,
        error: ""
      };

      try {
        const job = await this.fetchJson("/api/downloads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: this.selectedItem.identifier,
            title: this.selectedItem.title,
            fileName: file.name,
            file: {
              name: file.name,
              format: file.format,
              size: file.size || 0,
              url: file.url,
              concurrency: this.downloadConcurrency
            },
            concurrency: this.downloadConcurrency
          })
        });
        this.downloadJob = job;
        this.activeDetailDownloadId = job.id;
        this.selectedDownloadId = job.id;
        this.activeView = "downloads";
        await this.loadDownloads();
        this.pollDownload(job.id);
      } catch (error) {
        this.downloadJob = {
          status: "error",
          received: 0,
          total: 0,
          error: error.message
        };
      }
    },

    async pauseDownload(job) {
      await this.updateDownload(job, "pause");
    },

    async resumeDownload(job) {
      await this.updateDownload(job, "resume");
    },

    async updateDownload(job, action) {
      if (!job) return;
      try {
        const updated = await this.fetchJson(`/api/downloads/${encodeURIComponent(job.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action })
        });
        this.downloads = this.downloads.map((candidate) => candidate.id === updated.id ? updated : candidate);
        this.selectedDownloadId = updated.id;
      } catch (error) {
        this.downloadsError = error.message;
      }
    },

    async deleteDownload(job) {
      if (!job) return;
      try {
        await this.fetchJson(`/api/downloads/${encodeURIComponent(job.id)}`, {
          method: "DELETE"
        });
        this.downloads = this.downloads.filter((candidate) => candidate.id !== job.id);
        this.selectedDownloadId = this.downloads[0]?.id || "";
      } catch (error) {
        this.downloadsError = error.message;
      }
    },

    async pollDownload(jobId) {
      try {
        const job = await this.fetchJson(`/api/downloads/${encodeURIComponent(jobId)}`);
        if (this.activeDetailDownloadId !== jobId) return;
        this.downloadJob = job;
        if (["complete", "error"].includes(job.status)) return;
        this.downloadTimer = window.setTimeout(() => this.pollDownload(jobId), 900);
      } catch (error) {
        if (this.activeDetailDownloadId !== jobId) return;
        this.downloadJob = {
          status: "error",
          received: 0,
          total: 0,
          error: error.message
        };
      }
    }
  }
}).mount("#app");
