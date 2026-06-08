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

Downloads use Node's built-in SQLite support, so Node.js 24 or newer is required.

## Features

- Search movies and classic TV/public video collections
- Search metadata from `youzisp.tv`, `jfxq.tv`, and MeijuTT domains
- Filter searches by provider from the Source menu
- View poster, year, creator, description, and available files
- Watch playable MP4/HLS files in the browser through local playback proxies
- Resolve YouziSP, JFXQ, and MeijuTT watch pages into public media URLs when the page exposes them
- Add selected files to a download list saved under `downloads/`
- Pause, resume, and delete download jobs from the Downloads page
- Download direct media files and VOD m3u8/HLS playlists, including AES-128 encrypted streams and byte-range playlists
- Configure parallel download connections per task
- Resume direct-file downloads with HTTP Range pieces and HLS downloads from cached segment files
- Persist download jobs and piece progress in `downloads/downloads.sqlite`
- Cache HLS segments as individual files while downloading, then assemble them in playlist order when all segments are complete
- Cache playback data under `downloads/playback-cache/` with automatic size and age cleanup

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
