# MyTV Legal Media Tool

A small Node.js + Vue.js web app for searching, watching, and downloading videos from sources.

## Run

```powershell
npm start
```

Open http://localhost:5177.

If port `5177` is already in use, the server automatically tries the next available port and prints the final URL.

To force a specific port in PowerShell:

```powershell
$env:PORT=5180; npm start
```

The frontend uses Vue 3 from the official CDN, so no build step is required. The app starts idle; enter a query and press Search.

Downloads and favorites use Node's built-in SQLite support, so Node.js 24 or newer is required.

## Features

- Search movies and classic TV/public video collections
- Search metadata from `youzisp.tv`, `jfxq.tv`, and MeijuTT domains
- Filter searches by provider from the Source menu
- View poster, year, creator, description, and available files
- Watch playable MP4/HLS files in the browser through local playback proxies
- Resolve YouziSP, JFXQ, and MeijuTT watch pages into public media URLs when the page exposes them
- Add the selected playable file to Favorites with its source page, provider, title, media URL, and cover URL
- Switch the left pane between Search, Favorites, and Downloads
- Play or delete saved favorites from the Favorites page
- Add selected files to a download list saved under `downloads/`
- Pause, resume, and delete download jobs from the Downloads page
- Download direct media files and VOD m3u8/HLS playlists, including AES-128 encrypted streams and byte-range playlists
- Configure parallel download connections per task
- Resume direct-file downloads with HTTP Range pieces and HLS downloads from cached segment files
- Persist download jobs and piece progress in `downloads/downloads.sqlite`
- Persist favorites in `downloads/favorites.sqlite`
- Cache HLS segments as individual files while downloading, then assemble them in playlist order when all segments are complete
- Cache playback data under `downloads/playback-cache/` with automatic size and age cleanup

## Downloads

Downloads are managed by `DownloadManager` and persisted in `downloads/downloads.sqlite`.

- Each download job stores its URL, output path, status, progress, concurrency, and error state.
- The Downloads page can pause, resume, and delete jobs.
- Re-adding the same media URL returns the existing job instead of creating a duplicate.
- Jobs that were `queued` or `downloading` before a process restart are restored as `paused` and can be resumed.

The download database is created with:

```sql
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  segment_index INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  piece_index INTEGER NOT NULL DEFAULT 0,
  piece_count INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 4,
  path TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  variant_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS download_pieces (
  job_id TEXT NOT NULL,
  piece_index INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, piece_index),
  FOREIGN KEY (job_id) REFERENCES downloads(id) ON DELETE CASCADE
);
```

Downloader implementations live in `downloaders/`:

- `base-downloader.js` defines shared lifecycle behavior, concurrency limits, abort handling, and progress persistence hooks.
- `direct-file-downloader.js` handles MP4/M4V/WebM/OGV/FLV-style direct media URLs.
- `hls-downloader.js` handles VOD m3u8/HLS playlists.

### Direct File Downloads

Direct downloads first probe HTTP Range support.

- If the server supports Range requests, the file is split into byte-range pieces.
- Multiple pieces are downloaded in parallel according to the task's `Connections` setting.
- Each piece writes directly into the `.part` file at its byte offset.
- Piece progress is stored in SQLite, so pause/resume can continue from already written byte ranges.
- If the server does not support Range requests, the downloader falls back to a single streaming connection.

### HLS Downloads

HLS downloads resolve master playlists to the highest-bandwidth media playlist, then download media segments.

- Segments download in parallel according to the task's `Connections` setting.
- Each completed segment is written to an individual file under `target-file.segments/`.
- Segment completion is stored in SQLite, so already cached segments are not re-downloaded after pause or restart.
- After every segment is present, segments are assembled in playlist order into the final output.
- The segment cache directory is removed after successful assembly.
- AES-128 encrypted playlists and HLS byte-range playlists are supported.
- SAMPLE-AES and non-identity key formats are not supported.

### Protected CDN URLs

Some media URLs play in a browser `<video>` element but fail in the server-side downloader. This usually means the CDN is checking browser-specific request details such as:

- Browser `User-Agent`
- `Range` request shape
- `Referer` or source page
- Cookies
- TLS/HTTP fingerprint
- Short-lived signed URL parameters

For example, a URL may look like an MP4 but redirect to an error page and return `402 Payment Required`. In that case the downloader reports the final redirected URL when possible. Playback can still work because browser media requests are not identical to Node.js `fetch` requests.

## Favorites

Use the Favorite button in the video detail panel to save the currently selected file. The Favorites view reuses the result-list layout, and selecting a favorite loads it into the viewer on the right.

Each favorite stores:

- Original source page URL
- Source/provider name
- Title
- Video/media URL
- Cover/poster URL

Favorites are saved in the `favorites` table in `downloads/favorites.sqlite`. The table is created with:

```sql
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  original_page_url TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS favorites_page_video_unique
  ON favorites(original_page_url, video_url);
```

## Playback Cache

Browser playback goes through local proxy endpoints so slow upstream media can be buffered ahead:

- HLS/m3u8 playback uses `/api/play/hls` and rewrites playlist segments to local cached segment URLs.
- MP4, M4V, WebM, and OGV playback uses `/api/play/direct` and serves HTTP `Range` requests from cached byte chunks.
- Direct playback stores 4 MB chunks and serves open-ended browser ranges, such as `bytes=0-`, as bounded playback windows so the whole video is not fetched at once.
- Both playback paths prefetch upcoming segments/chunks in parallel.
- Playback cache files are temporary acceleration data, separate from saved downloads.

Playback cache defaults:

```powershell
$env:PLAYBACK_CACHE_MAX_BYTES=2147483648
$env:PLAYBACK_CACHE_MAX_AGE_MS=259200000
$env:PLAYBACK_CACHE_CLEANUP_INTERVAL_MS=60000
$env:HLS_PLAYBACK_CONCURRENCY=4
$env:HLS_PLAYBACK_PREFETCH_AHEAD=4
$env:DIRECT_PLAYBACK_CONCURRENCY=4
$env:DIRECT_PLAYBACK_PREFETCH_AHEAD=4
```

`PLAYBACK_CACHE_MAX_BYTES` defaults to 2 GB and is split between HLS and direct playback unless `HLS_PLAYBACK_CACHE_MAX_BYTES` or `DIRECT_PLAYBACK_CACHE_MAX_BYTES` is set. Cache cleanup runs on startup and after new playback cache files are written. Active playback sessions are not removed while cleanup is running.

## Adding Providers

Provider logic lives in `providers/`.

- `providers/base-provider.js` defines `BaseProvider` and `ProviderRegistry`.
- `providers/archive-provider.js` implements Internet Archive search, item details, and direct file selection.
- `providers/generic-page-provider.js` supports sites that only need search/detail/play URL patterns.
- `providers/youzisp-provider.js` implements YouziSP search plus media URL resolving.
- `providers/jfxq-provider.js` implements JFXQ search plus media URL resolving.
- `providers/meijutt-provider.js` implements MeijuTT search plus media URL resolving.
- `providers/index.js` registers active providers and drives the Source menu through `/api/providers`.

To add another source, create a provider class that extends `BaseProvider` or `GenericPageProvider`, then register an instance in `providers/index.js`. Override `searchUrls()`, `parseDetail()`, or `resolveMedia()` as needed.
