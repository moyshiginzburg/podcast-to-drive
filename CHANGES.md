# Change log

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
