const { createApp } = Vue;
const MEDIA_URL_PATTERN = /\.(m3u8|mp4|m4v|mov|webm|ogv|mpd|flv)(?:[?#]|$)/i;
const HLS_URL_PATTERN = /\.m3u8(?:[?#]|$)/i;

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
      favorites: [],
      favoritesLoading: false,
      favoritesError: "",
      selectedFavoriteId: "",
      activeView: "search",
      downloadTimer: null,
      hls: null,
      playInput: "",
      playError: "",
      playStatus: "",
      playObjectUrl: ""
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
      return this.mediaUrlForFile(this.selectedFile);
    },

    embeddedPlayerUrl() {
      return this.selectedFile?.embedUrl || "";
    },

    externalPlayerUrl() {
      const file = this.selectedFile;
      if (!file || file.embedUrl || file.playbackUrl || file.objectUrl || !file.url || file.resolvable || MEDIA_URL_PATTERN.test(String(file.url))) return "";
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
      return !this.selectedFile || this.selectedFile.local || this.downloadBusy || Boolean(this.selectedFileDownload);
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
    },

    favoritesLabel() {
      if (this.favoritesLoading) return "Loading";
      if (!this.favorites.length) return "No favorites";
      return `${this.favorites.length} favorites`;
    },

    selectedFavorite() {
      const sourceUrl = this.selectedItem?.sourceUrl || "";
      const videoUrl = this.selectedFile?.url || "";
      if (!sourceUrl || !videoUrl) return null;
      return this.favorites.find((favorite) => (
        favorite.originalPageUrl === sourceUrl && favorite.videoUrl === videoUrl
      )) || null;
    },

    favoriteDisabled() {
      return !this.selectedItem || !this.selectedFile || this.selectedFile.local || Boolean(this.selectedFavorite) || this.detailLoading;
    },

    favoriteLabel() {
      return this.selectedFavorite ? "Favorited" : "Favorite";
    },

    emptyViewerTitle() {
      if (this.activeView === "favorites") return "Select a favorite";
      if (this.activeView === "play") return "Enter a video";
      return "Select a video";
    },

    emptyViewerDescription() {
      if (this.activeView === "favorites") {
        return "Favorites appear on the left. Choose one to play or remove it from the list.";
      }
      if (this.activeView === "play") {
        return "Paste a direct video or HLS address, enter a local file path, or choose a local video file.";
      }
      return "Search results appear on the left. Choose one to inspect playable files, watch, or download.";
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
    this.loadFavorites();
    this.downloadsTimer = window.setInterval(() => this.loadDownloads({ quiet: true }), 1200);
  },

  beforeUnmount() {
    if (this.downloadTimer) window.clearTimeout(this.downloadTimer);
    if (this.downloadsTimer) window.clearInterval(this.downloadsTimer);
    this.clearPlayObjectUrl();
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

    openFavorites() {
      this.activeView = "favorites";
      this.loadFavorites();
    },

    openPlay() {
      this.activeView = "play";
    },

    clearPlayObjectUrl() {
      if (this.playObjectUrl) {
        URL.revokeObjectURL(this.playObjectUrl);
        this.playObjectUrl = "";
      }
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

    favoriteSummary(favorite) {
      return favorite.videoUrl || "No video URL saved.";
    },

    mediaFormatLabel(url) {
      const match = String(url || "").match(/\.(m3u8|mp4|m4v|mov|webm|ogv|ogg|mkv|ts|mpd|flv)(?:[?#]|$)/i);
      return match ? match[1].toUpperCase() : "Source page";
    },

    inputTitle(value) {
      const raw = String(value || "").trim();
      try {
        const parsed = new URL(raw);
        const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
        return name || parsed.hostname || "Manual video";
      } catch {
        return raw.split(/[\\/]/).filter(Boolean).pop() || "Local video";
      }
    },

    formatForManualUrl(url) {
      if (this.isHlsUrl(url)) return "HLS";
      const label = this.mediaFormatLabel(url);
      return label === "Source page" ? "Direct URL" : label;
    },

    loadPlayItem(file) {
      this.activeView = "play";
      this.selectedId = file.id;
      this.selectedFavoriteId = "";
      this.selectedFileIndex = 0;
      this.detailLoading = false;
      this.downloadJob = null;
      this.clearDetailDownloadPolling();
      this.selectedItem = {
        id: file.id,
        identifier: file.id,
        title: file.title,
        creator: "",
        year: "",
        description: file.description || file.url,
        poster: "",
        source: file.local ? "Local" : "Manual",
        sourceUrl: file.sourceUrl || "",
        files: [{
          name: file.name || file.title,
          format: file.format,
          size: file.size || 0,
          url: file.url,
          playbackUrl: file.playbackUrl || "",
          objectUrl: file.objectUrl || "",
          local: Boolean(file.local)
        }]
      };
      this.$nextTick(() => this.playSelectedMedia());
    },

    async submitPlayInput() {
      const value = this.playInput.trim();
      this.playError = "";
      this.playStatus = "";
      if (!value) {
        this.playError = "Enter a video URL or local file path.";
        return;
      }

      try {
        this.clearPlayObjectUrl();
        if (/^https?:\/\//i.test(value)) {
          this.loadPlayItem({
            id: `manual-url:${value}`,
            title: this.inputTitle(value),
            name: this.inputTitle(value),
            format: this.formatForManualUrl(value),
            url: value,
            playbackUrl: this.playbackUrlFor(value, { forceDirect: !this.isHlsUrl(value) }),
            sourceUrl: value,
            description: "Manual video URL"
          });
          this.playStatus = "Loading through the playback proxy.";
          return;
        }

        const media = await this.fetchJson("/api/local-media", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: value })
        });
        this.loadPlayItem({
          id: `local:${media.token}`,
          title: media.name,
          name: media.name,
          format: this.mediaFormatLabel(media.name),
          size: media.size,
          url: value,
          playbackUrl: media.url,
          local: true,
          description: "Local video file"
        });
        this.playStatus = "Playing local file through the local server.";
      } catch (error) {
        this.playError = error.message;
      }
    },

    handlePlayFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      this.playError = "";
      this.clearPlayObjectUrl();
      this.playObjectUrl = URL.createObjectURL(file);
      this.playInput = file.name;
      this.loadPlayItem({
        id: `file:${file.name}:${file.size}:${file.lastModified}`,
        title: file.name,
        name: file.name,
        format: this.mediaFormatLabel(file.name),
        size: file.size,
        url: file.name,
        objectUrl: this.playObjectUrl,
        local: true,
        description: "Selected local browser file"
      });
      this.playStatus = "Playing selected local file.";
      event.target.value = "";
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

    async loadFavorites(options = {}) {
      if (!options.quiet) {
        this.favoritesLoading = true;
        this.favoritesError = "";
      }
      try {
        const data = await this.fetchJson("/api/favorites");
        this.favorites = data.favorites || [];
        if (this.selectedFavoriteId && !this.favorites.some((favorite) => favorite.id === this.selectedFavoriteId)) {
          this.selectedFavoriteId = "";
        }
      } catch (error) {
        if (!options.quiet) this.favoritesError = error.message;
      } finally {
        if (!options.quiet) this.favoritesLoading = false;
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
      this.selectedFavoriteId = "";
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

    favoriteToItem(favorite) {
      return {
        id: favorite.id,
        identifier: favorite.id,
        title: favorite.title,
        creator: "",
        year: "",
        description: favorite.videoUrl,
        poster: favorite.coverUrl,
        source: favorite.source,
        sourceUrl: favorite.originalPageUrl,
        files: [{
          name: "Favorite video",
          format: this.mediaFormatLabel(favorite.videoUrl),
          size: 0,
          url: favorite.videoUrl,
          external: !MEDIA_URL_PATTERN.test(String(favorite.videoUrl || ""))
        }]
      };
    },

    loadFavorite(favorite) {
      this.selectedId = favorite.id;
      this.selectedFavoriteId = favorite.id;
      this.selectedItem = this.favoriteToItem(favorite);
      this.selectedFileIndex = 0;
      this.detailLoading = false;
      this.downloadJob = null;
      this.clearDetailDownloadPolling();
      this.$nextTick(() => {
        const player = this.$refs.player;
        if (player) player.load();
      });
    },

    async addFavorite() {
      if (!this.selectedItem || !this.selectedFile) return;

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

      try {
        const favorite = await this.fetchJson("/api/favorites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            originalPageUrl: this.selectedItem.sourceUrl,
            source: this.selectedItem.source,
            title: `${this.selectedItem.title} - ${file.name}`,
            videoUrl: file.url,
            coverUrl: this.selectedItem.poster
          })
        });
        await this.loadFavorites({ quiet: true });
        this.selectedFavoriteId = favorite.id;
      } catch (error) {
        this.favoritesError = error.message;
      }
    },

    async deleteFavorite(favorite) {
      if (!favorite) return;
      try {
        await this.fetchJson(`/api/favorites/${encodeURIComponent(favorite.id)}`, {
          method: "DELETE"
        });
        this.favorites = this.favorites.filter((candidate) => candidate.id !== favorite.id);
        if (this.selectedFavoriteId === favorite.id) {
          this.selectedFavoriteId = "";
          if (this.activeView === "favorites") {
            this.selectedId = "";
            this.selectedItem = null;
          }
        }
      } catch (error) {
        this.favoritesError = error.message;
      }
    },

    isHlsUrl(url) {
      return HLS_URL_PATTERN.test(String(url || ""));
    },

    isDirectPlaybackUrl(url) {
      return /\.(mp4|m4v|mov|webm|ogv)(?:[?#]|$)/i.test(String(url || ""));
    },

    playbackUrlFor(url, options = {}) {
      const mediaUrl = String(url || "");
      if (this.isHlsUrl(mediaUrl)) {
        const params = new URLSearchParams({ url: mediaUrl });
        return `/api/play/hls?${params}`;
      }
      if (options.forceDirect || this.isDirectPlaybackUrl(mediaUrl)) {
        const params = new URLSearchParams({ url: mediaUrl });
        return `/api/play/direct?${params}`;
      }
      return mediaUrl;
    },

    mediaUrlForFile(file) {
      if (!file) return "";
      if (file.playbackUrl) return file.playbackUrl;
      if (file.objectUrl) return file.objectUrl;
      const url = file.url || "";
      return MEDIA_URL_PATTERN.test(url) ? this.playbackUrlFor(url) : "";
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
        const mediaUrl = this.mediaUrlForFile(file);
        if (!mediaUrl) return;

        if (this.isHlsUrl(file.url) && window.Hls && window.Hls.isSupported()) {
          this.hls = new Hls();
          player.removeAttribute("src");
          this.hls.loadSource(mediaUrl);
          this.hls.attachMedia(player);
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            player.play().catch(() => {});
          });
          return;
        }

        player.src = mediaUrl;
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

      if (!file.playbackUrl && !file.objectUrl && !MEDIA_URL_PATTERN.test(String(file.url || ""))) {
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

      if (!file.playbackUrl && !MEDIA_URL_PATTERN.test(String(file.url || ""))) {
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
