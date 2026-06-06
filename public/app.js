const { createApp } = Vue;
const MEDIA_URL_PATTERN = /\.(m3u8|mp4|m4v|webm|ogv|mpd)(?:[?#]|$)/i;

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
      return MEDIA_URL_PATTERN.test(url) ? url : "";
    },

    detailMeta() {
      if (!this.selectedItem) return "";
      return this.itemMeta(this.selectedItem);
    },

    downloadBusy() {
      return this.downloadJob && !["complete", "error"].includes(this.downloadJob.status);
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
  },

  beforeUnmount() {
    if (this.downloadTimer) window.clearTimeout(this.downloadTimer);
    this.destroyHls();
  },

  methods: {
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
          this.hls.loadSource(file.url);
          this.hls.attachMedia(player);
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            player.play().catch(() => {});
          });
          return;
        }

        player.src = file.url;
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

      if (this.selectedFile.resolvable) {
        try {
          await this.resolveSelectedFile();
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
      } else if (!MEDIA_URL_PATTERN.test(String(this.selectedFile.url || ""))) {
        window.open(this.selectedFile.url, "_blank", "noopener,noreferrer");
        return;
      }

      this.playSelectedMedia();
    },

    async startDownload() {
      if (!this.selectedItem || !this.selectedFile) return;

      this.downloadJob = {
        status: "starting",
        received: 0,
        total: this.selectedFile.size || 0,
        error: ""
      };

      try {
        const job = await this.fetchJson("/api/downloads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: this.selectedItem.identifier,
            fileName: this.selectedFile.name
          })
        });
        this.downloadJob = job;
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

    async pollDownload(jobId) {
      try {
        this.downloadJob = await this.fetchJson(`/api/downloads/${encodeURIComponent(jobId)}`);
        if (["complete", "error"].includes(this.downloadJob.status)) return;
        this.downloadTimer = window.setTimeout(() => this.pollDownload(jobId), 900);
      } catch (error) {
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
