# Change log

## 2026-04-18

- **Subscribe by RSS URL:** Header button (🔗) opens a dialog to paste a feed URL. The server validates the feed with `parseRSS`, then adds the subscription using the channel title and artwork.
- **Sidebar – subscriptions list after search:** The back control from the search screen now calls `loadPodcastList()` so the podcast list is refetched from the server instead of showing a stale empty state until the spreadsheet is refreshed.
- **Downloads vs Drive:** Before treating an episode as already downloaded, the script checks whether the expected MP3 (or the first part of a chunked download) still exists in the podcast folder. If the file was removed from Drive, the URL is removed from the downloaded set so the episode can be downloaded again.
- **Log sheet:** Added a **קישור** (link) column. Successful downloads (manual and automatic) write Drive file URLs into that column; existing `Log` sheets gain the new header in column F on the next log write.
