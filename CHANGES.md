## 2026-06-21 – UX, OPML, and Terminology overhaul
- Improved OPML import UX with a dedicated file upload button and automatic search for backups in Google Drive.
- Implemented automatic background backup to OPML after subscription changes.
- Automatically limit OPML backups to the 2 most recent files.
- Fetch podcast metadata (image & title) rapidly during OPML import to prevent missing UI artwork.
- Added sorting preference for podcasts (Date added vs Alphabetical), saved inside the Google Sheet settings.
- Standardized Hebrew terminology across the project to use 'הסכת' (hesket) instead of 'פודקאסט'.
- Ensured auto-generated sheets like 'Settings' and 'Download Queue' remain visible in the Google Sheets document.

# Change log

## 2026-06-18 – UrlFetch Bandwidth Limit Graceful Handling

- **Bug Fix:** Fixed an issue where extremely fast podcast servers combined with the new efficient upload logic caused `UrlFetchApp` to exceed Google's internal upload bandwidth heuristics ("UrlFetch failed because of too much upload bandwidth used"). The error is now intercepted and treated as a soft stop (`TIME_BUDGET_EXCEEDED`), allowing the chunked upload to safely resume in the next worker run (after 1 minute) without failing the queue or artificially slowing down normal downloads.

## 2026-06-17 – Resumable Upload (Drive API) migration

### Overview
Replaced the old `downloadChunked` approach (splitting episodes into numbered part files of ~45 MB)
with a new `downloadResumable` function that streams any-size episode to Google Drive as a **single
complete file** using the [Drive Resumable Upload API](https://developers.google.com/drive/api/guides/manage-uploads#resumable).

### New features
- **Bypassing the 50MB limit:** Natively supports downloading and uploading files much larger than 50MB (overcoming the Apps Script `UrlFetchApp` payload size limits) without corrupting or splitting the file.
- **Single-file output:** Episodes that previously produced `"(חלק 001)", "(חלק 002)"` files in Drive
  are now stored as one complete audio file, identical byte-for-byte to the original.
- **No more OOM (Out of Memory) crashes:** Each iteration loads only 10 MB into the JS heap (down from 45 MB).
  After uploading a chunk to Drive the bytes are released before the next iteration begins.
- **Multi-format support:** `detectFileExtension()` inspects the episode URL path and the
  `Content-Type` response header to choose the correct file extension (mp3, m4a, mp4, ogg, opus,
  aac, wav). `buildFileName` now accepts an `ext` argument instead of always defaulting to `.mp3`.
- **Cross-run resume:** If the 4-minute soft time budget is exceeded mid-download, the Drive session
  URL and byte offset are saved to the queue job. When the worker runs again it calls
  `queryResumableSessionProgress()` to ask Drive how many bytes it already has, then resumes from
  that byte without creating duplicate files.
- **Bug Fixes:**
  - Fixed an issue in `queryResumableSessionProgress` where manually setting `'Content-Length': '0'` threw a Google Apps Script runtime error (`Header:Content-Length`). The query now sends an empty `Uint8Array` payload to query session progress.
  - Fixed an `HTTP 400` error during session progress checks by adding the required `'bytes '` prefix to the `Content-Range` header (changing `'*/*'` to `'bytes */*'`).
  - Fixed a state mismatch where a failed query (due to expired session or error) fell back to a new session but failed to reset the byte offset, causing `HTTP 503` mismatch errors. Now, falling back to a new session also clears the stale offset.
- **Manual downloads now route through the queue worker:** Clicking "הורד לדרייב" in the sidebar no longer runs the download inline (which would crash after 6 minutes on large files). Instead, it calls `enqueueDownloadJob()` and immediately schedules `downloadWorker`. The worker handles large/video files with the same soft-stop + cross-run resume logic used by automatic downloads. The sidebar button shows `✓ בתור` instantly. A new helper `isEpisodeInQueue()` prevents duplicate queue entries if the button is clicked twice.
- **Unknown content-length support:** For servers that omit `Content-Length`, intermediate chunks
  are uploaded with `Content-Range: bytes start-end/*` and the final chunk uses the actual total.

### Breaking / removed
- `downloadChunked()` – deleted; all downloads now go through `downloadResumable()`.
- `normalizeFirstChunkDurationMetadata()` and its low-level helpers (`byteAt`, `hasAsciiAt`,
  `parseSynchsafeInt`) – deleted; metadata repair is no longer needed because the file is never
  split.
- `buildTimeBudgetExceededError()` – deleted; the equivalent error object is built inline in
  `downloadResumable`.
- `CHUNK_SIZE` changed from 45 MB → 10 MB.
- `downloadWorker` no longer saves `resumePart` to the queue; it saves `resumeSessionUrl` instead.

### Modified files
- `appsscript.json` – explicit `oauthScopes` array added (Drive, Spreadsheets, scriptapp,
  external_request) so `getOAuthToken()` receives the required Drive scope without Advanced
  Services.
- `Code.gs` – see items above.

## 2026-04-22

- **Favicon Update:** Added the microphone (🎙) favicon to the GitHub Pages site (`index.html`) for brand consistency. Implemented favicon using SVG Data URI for better performance and cross-browser support.

## 2026-04-20

- **RSS parse early exit for memory pressure:** `parseRSS` now accepts an optional subscription cutoff timestamp and evaluates `pubDate` before building episode objects. In automatic runs, parsing stops (`break`) as soon as it reaches an item older than the subscription date, so large feeds no longer allocate full episode arrays before filtering.
- **Separated scraper/downloader executions:** `podcastManager` now enqueues pending episodes into a hidden queue sheet instead of downloading inline. A new `downloadWorker` trigger handler pops one queue item per run, performs `downloadEpisodeToFolder` in a fresh execution context, persists chunk resume offsets when soft time budget is hit, and self-reschedules until the queue is empty.
- **Direct-download fallback for false Content-Length:** when `downloadEpisodeToFolder` selects direct mode (`contentLength <= CHUNK_SIZE`), `downloadDirect` is wrapped in `try/catch`. If the error includes `מגבלת UrlFetch`, it immediately falls back to `downloadChunked(..., null, options)` so lying servers no longer cause false “no Range support” outcomes.

## 2026-04-19 (later)

- **Auto vs manual “already downloaded”:** `syncDownloadedFlagWithDrive` (clear URL from `הורדות` when the MP3 is missing from Drive) runs only for **manual** sidebar downloads. **`podcastManager` (automatic / “הפעל הורדה עכשיו”)** no longer calls it, so deleting files to free space does not trigger automatic re-download; manual re-fetch still works when the file is gone.

## 2026-04-19

- **Execution debug logging:** Added `debugStep` / `debugSnippet` helpers that write structured `[podcast]` lines via `console.log` (visible under Apps Script → Executions). Logs cover `podcastManager` flow, RSS fetch/parse, `fetchContentLength`, direct vs chunked downloads (including each Range part, `getContent`, Drive `createFile`), and sidebar `downloadEpisode`. Passes optional `runT0` so lines show elapsed milliseconds since run start.

- **Large episode stability (memory):** Execution logs showed the runtime dying right after loading chunk 2 into memory, before `newBlob` — consistent with RAM pressure (two big byte arrays + blob build), not the 360s limit. Fixes: `normalizeFirstChunkDurationMetadata` no longer does a full-array `slice()` (in-place Xing clear); removed invalid `HEAD` in `fetchContentLength` (UrlFetch only allows get/post/put/delete/patch); clear `resp`/`bytes` after use; use `bytes.length` for part length (never `blob.getBytes()` for size). `CHUNK_SIZE` remains 45MB to stay under the ~50MB UrlFetch response cap while minimizing part count.

## 2026-04-18

- **README (Hebrew section):** Wrapped the Hebrew documentation in a single `<div dir="rtl">` so GitHub renders RTL layout without per-element alignment. Replaced generic section titles with headings that describe what each section covers (installation paths, sidebar actions, storage, troubleshooting).
- **Subscribe by RSS URL:** Header button (🔗) opens a dialog to paste a feed URL. The server validates the feed with `parseRSS`, then adds the subscription using the channel title and artwork.
- **Sidebar – subscriptions list after search:** The back control from the search screen now calls `loadPodcastList()` so the podcast list is refetched from the server instead of showing a stale empty state until the spreadsheet is refreshed.
- **Downloads vs Drive:** Before treating an episode as already downloaded, the script checks whether the expected MP3 (or the first part of a chunked download) still exists in the podcast folder. If the file was removed from Drive, the URL is removed from the downloaded set so the episode can be downloaded again.
- **Large-file integrity (50MB UrlFetch cap):** For episodes with unknown size, downloads now start with Range-based chunking instead of direct fetch. The script also validates full-response byte counts, and if a large server response is truncated or Range is unsupported, it stops with a clear error instead of saving a corrupted partial MP3.
- **Chunked MP3 part duration display:** In split downloads, part 001 now clears Xing/Info total-length metadata from the first chunk so players show duration based on the actual part length (instead of the full original episode length).
- **RSS add dialog visibility:** Fixed a sidebar CSS issue where the RSS URL dialog backdrop was missing default hidden styles and appeared even before clicking 🔗. RSS modal now follows the same hidden/visible behavior as OPML modal.
- **Log links for split downloads:** The Log sheet now writes rich-text hyperlinks in the קישור cell, so when an episode has multiple Drive URLs (one per chunk), each URL is clickable on its own line.
- **Log sheet:** Added a **קישור** (link) column. Successful downloads (manual and automatic) write Drive file URLs into that column; existing `Log` sheets gain the new header in column F on the next log write.
- **Chore**: Increased scheduling delay for background triggers from 1 millisecond / 30 seconds to 1 minute to prevent Google Apps Script scheduler throttling.
- **Performance**: Upgraded resumable upload to use `Blob` payload for HTTP 206 chunks instead of `getContent()`. This avoids expanding binary data into the JS-heap, preventing OOM crashes entirely, and allows `CHUNK_SIZE` to safely increase from 10 MB to 45 MB. Uploads are now 3-4x faster.
