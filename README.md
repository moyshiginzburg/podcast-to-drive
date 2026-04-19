# Podcast manager for Google Drive & Sheets

## What this project does

This **Google Apps Script** project is bound to a **Google Sheet**. It adds a custom menu and a **modal manager** (`Sidebar.html`) to subscribe to podcasts (iTunes search, **RSS URL**, or **OPML**), browse episodes, download MP3s to **Google Drive** under a root folder named `הסכתים`, and optionally run **automatic downloads** every six hours. A **`Log`** sheet records downloads and errors; successful rows include a **`קישור`** column with Drive URLs (rich text when an episode is split into multiple files).

**Purpose:** keep podcast subscriptions and files in your Drive with a simple Hebrew UI, while sheet and Drive layout stay predictable.

**How it works (high level):** the script reads subscriptions from the `מנויים` sheet, fetches each RSS feed, compares episodes against the `הורדות` sheet and Drive, downloads new audio into per-podcast subfolders, and appends rows to `Log`.

## Project files

| File | Role |
|------|------|
| `Code.gs` | Server logic: RSS, Drive, subscriptions, downloads, triggers, logging |
| `Sidebar.html` | Modal UI served by `HtmlService` (Hebrew user-facing strings) |
| `appsscript.json` | Manifest: V8 runtime, `timeZone` (`Asia/Jerusalem`), exception logging |
| `CHANGES.md` | Change log (English) |

## Installation

### Option A – clasp (recommended for developers)

1. Install [clasp](https://github.com/google/clasp): `npm install -g @google/clasp`
2. Run `clasp login`
3. From this folder: `clasp create --title "Your title" --type sheets` (creates a new Sheet + bound script), then `clasp push`
4. Open the Sheet → **Extensions → Apps Script**, run **`onOpen`** once and complete **authorization**
5. Refresh the Sheet

### Option B – Manual copy in the browser

1. Create a new **Google Sheet**
2. **Extensions → Apps Script**
3. Replace the default `Code.gs` with this repository’s `Code.gs`
4. Add an **HTML** file named **`Sidebar`** (no extension) with the contents of `Sidebar.html`
5. In project settings, enable **Show app manifest** and align `appsscript.json` with this repo
6. Save, run **`onOpen`**, approve permissions, refresh the Sheet

## Spreadsheet menu (`🎙 הסכתים`)

After `onOpen`, the Sheet shows a custom menu (labels are Hebrew as in `Code.gs`):

| Menu item | Behavior |
|-----------|----------|
| **פתח מנהל הסכתים** | Opens the modal manager (`showSidebar`) |
| **הפעל הורדה עכשיו** | Runs `podcastManager` once (same logic as the automatic job) |
| **התקן טריגר אוטומטי (כל 6 שעות)** | Schedules `podcastManager` every 6 hours |
| **הסר טריגר אוטומטי** | Removes the periodic trigger |

## Using the manager window

- **Search** – find podcasts via the iTunes API and subscribe from results  
- **RSS URL** – paste a feed URL; the server validates with `parseRSS` before saving  
- **OPML** – import / export subscriptions  
- After subscribing from search, use **Back** so the list reloads from the server (`loadPodcastList`)

## Automatic downloads

Install the trigger from the menu above. Episodes published **after** the subscription date (`תאריך הרשמה` on `מנויים`) are candidates for download. Uninstall the trigger when you no longer want scheduled runs.

## Storage layout

Sheet and column names match the constants in `Code.gs` (Hebrew where defined):

| Location | Contents |
|----------|----------|
| Sheet **`מנויים`** | Subscriptions: `כתובת RSS`, `שם`, `תמונה`, `תאריך הרשמה`, `סטטוס` (`פעיל` / `בוטל`) |
| Sheet **`הורדות`** | Downloaded episode URLs (`כתובת`) |
| Sheet **`Log`** | Columns: `תאריך`, `פודקאסט`, `פרק`, `סטטוס`, `הערה`, `קישור` |
| Script **Properties** | `lastRunTime`, `resumeState`, `oneTimeTrigId` (resume / continuation triggers) |
| Drive **`הסכתים/`** | Root folder |
| Drive **`הסכתים/<podcast name>/`** | MP3 files |

Legacy data may be migrated once from Script Properties into `מנויים` / `הורדות` (`subscriptions`, `downloadedUrls`).

## Technical notes

- **Script time zone:** `Session.getScriptTimeZone()` follows `appsscript.json` (`Asia/Jerusalem`). The **spreadsheet** also has its own time zone under **File → Settings**; align both if you care about consistent date display in cells.
- **Filenames:** `YYMMDD <episode title>.mp3`. Large downloads use chunked parts: `YYMMDD <title> (חלק 001).mp3`, etc. (`CHUNK_SIZE` is 45 MB; `UrlFetch` responses are capped at 50 MB).
- **Execution limit:** Long automatic runs save `resumeState` and schedule a one-time continuation trigger. Time checks run at podcast and episode boundaries, and in chunked downloads resume can continue from the saved chunk offset/part instead of restarting the whole episode. A guard one-time trigger is also created at run start and removed on successful completion, so abrupt runtime crashes still get a continuation run; `lastRunTime` is updated when a full run completes successfully.
- **“Already downloaded” vs Drive:** Before trusting the `הורדות` flag, the script checks that the expected file(s) still exist in Drive; if you deleted a file, the URL can be cleared so the episode can download again.
- **`HtmlService` / `google.script.run`:** If you see **PERMISSION_DENIED** (“error reading from storage”), try a **single Google account** in the browser (e.g. **Incognito** with one account); multiple simultaneous logins often cause this.

## License

See `LICENSE` in this repository.
