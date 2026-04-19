# Change log

## 2026-04-19

- **Execution debug logging:** Added `debugStep` / `debugSnippet` helpers that write structured `[podcast]` lines via `console.log` (visible under Apps Script → Executions). Logs cover `podcastManager` flow, RSS fetch/parse, `fetchContentLength`, direct vs chunked downloads (including each Range part, `getContent`, Drive `createFile`), and sidebar `downloadEpisode`. Passes optional `runT0` so lines show elapsed milliseconds since run start.

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
