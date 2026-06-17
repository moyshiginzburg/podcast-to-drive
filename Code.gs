/**
 * Podcast to Drive
 * Author: Moyshi
 * GitHub: https://github.com/moyshiginzburg/podcast-to-drive
 * Version: 2026-06-17
 * License: AGPL-3.0
 */

// ============================================================
// PODCAST MANAGER FOR GOOGLE DRIVE
// ============================================================

// --- Constants ---
const ROOT_FOLDER_NAME = 'הסכתים';
const LOG_SHEET_NAME = 'Log';
const SUBSCRIPTIONS_SHEET_NAME = 'מנויים';
const DOWNLOADS_SHEET_NAME = 'הורדות';
const SUBSCRIPTIONS_HEADERS = ['כתובת RSS', 'שם', 'תמונה', 'תאריך הרשמה', 'סטטוס'];
const DOWNLOADS_HEADERS = ['כתובת'];
const STATUS_ACTIVE = 'פעיל';
const STATUS_CANCELLED = 'בוטל';
const LEGACY_PROP_SUBSCRIPTIONS = 'subscriptions';
const LEGACY_PROP_DOWNLOADED = 'downloadedUrls';
const PROP_LAST_RUN = 'lastRunTime';
const PROP_RESUME = 'resumeState';
const PROP_ONE_TIME_TRIG = 'oneTimeTrigId';
const PROP_DOWNLOAD_WORKER_TRIG = 'downloadWorkerTrigId';
const DOWNLOAD_QUEUE_SHEET_NAME = 'תור הורדות';
const DOWNLOAD_QUEUE_HEADERS = ['payload'];
/**
 * Chunk size for the Resumable Upload loop: each iteration downloads this many bytes from the
 * podcast server and immediately streams them up to the Drive Resumable Upload session.
 *
 * Using getBlob() instead of getContent() keeps the chunk data in the Java-side heap,
 * never expanding it into a JS number array. This means each 45 MB chunk consumes ~0 MB
 * of the GAS JS-heap, making OOM crashes impossible regardless of chunk size.
 *
 * 45 MB is also an exact multiple of 256 KB (45 * 1024 * 1024 / 262144 = 180), which is
 * required by the Drive Resumable Upload API for non-final chunks.
 */
const CHUNK_SIZE = 45 * 1024 * 1024; // 45 MB – safe with Blob-passthrough (no JS-heap expansion)
const URL_FETCH_RESPONSE_LIMIT = 50 * 1024 * 1024; // Apps Script UrlFetch response cap
const SOFT_STOP_MS = 4 * 60 * 1000;
const RESUME_TRIGGER_DELAY_MS = 60 * 1000; // 1 minute (to prevent Google scheduler throttling)
/** Script property key that persists a Drive Resumable Upload session URL across worker runs. */
const PROP_RESUMABLE_SESSION = 'resumableSessionUrl';

/**
 * Purpose: Structured lines in the Apps Script execution log (Executions) to trace where a run
 *   spends time or stops. Remove or reduce once debugging is done.
 * Operation: `console.log` with optional elapsed ms since `runT0` (set once per `podcastManager` /
 *   manual download). Long strings are truncated to keep logs readable.
 */
function debugSnippet(text, maxLen) {
  const s = String(text || '');
  const n = maxLen != null ? maxLen : 120;
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function debugStep(label, detail, runT0) {
  const elapsed = runT0 != null ? `+${Date.now() - runT0}ms ` : '';
  const tail = detail != null && detail !== '' ? ` | ${detail}` : '';
  console.log(`[podcast] ${elapsed}${label}${tail}`);
}

// ============================================================
// MENU & SIDEBAR
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎙 הסכתים')
    .addItem('פתח מנהל הסכתים', 'showSidebar')
    .addSeparator()
    .addItem('הפעל הורדה עכשיו', 'podcastManager')
    .addItem('התקן טריגר אוטומטי (כל 6 שעות)', 'installTrigger')
    .addItem('הסר טריגר אוטומטי', 'uninstallTrigger')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('🎙 מנהל הסכתים')
    .setWidth(720)
    .setHeight(580);
  SpreadsheetApp.getUi().showModalDialog(html, '🎙 מנהל הסכתים');
}

// ============================================================
// TRIGGER MANAGEMENT
// ============================================================

function installTrigger() {
  uninstallTrigger();
  ScriptApp.newTrigger('podcastManager').timeBased().everyHours(6).create();
  SpreadsheetApp.getUi().alert('טריגר אוטומטי הותקן – יפעל כל 6 שעות.');
}

function uninstallTrigger() {
  getPeriodicTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

function getPeriodicTriggers() {
  return ScriptApp.getProjectTriggers().filter(t =>
    t.getHandlerFunction() === 'podcastManager' &&
    t.getEventType() === ScriptApp.EventType.CLOCK &&
    t.getUniqueId() !== PropertiesService.getScriptProperties().getProperty(PROP_ONE_TIME_TRIG)
  );
}

function deleteOneTimeTrigger() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_ONE_TIME_TRIG);
  if (!id) return;
  ScriptApp.getProjectTriggers()
    .filter(t => t.getUniqueId() === id)
    .forEach(t => ScriptApp.deleteTrigger(t));
  props.deleteProperty(PROP_ONE_TIME_TRIG);
}

function ensureOneTimeTrigger(delayMs) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_ONE_TIME_TRIG);
  if (id) {
    const exists = ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === id);
    if (exists) return;
    props.deleteProperty(PROP_ONE_TIME_TRIG);
  }
  const trig = ScriptApp.newTrigger('podcastManager').timeBased().after(delayMs).create();
  props.setProperty(PROP_ONE_TIME_TRIG, trig.getUniqueId());
}

function deleteDownloadWorkerTrigger() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_DOWNLOAD_WORKER_TRIG);
  if (!id) return;
  ScriptApp.getProjectTriggers()
    .filter(t => t.getUniqueId() === id)
    .forEach(t => ScriptApp.deleteTrigger(t));
  props.deleteProperty(PROP_DOWNLOAD_WORKER_TRIG);
}

function scheduleDownloadWorkerAfterMs(delayMs) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_DOWNLOAD_WORKER_TRIG);
  if (id) {
    const exists = ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === id);
    if (exists) return;
    props.deleteProperty(PROP_DOWNLOAD_WORKER_TRIG);
  }
  const trig = ScriptApp.newTrigger('downloadWorker').timeBased().after(delayMs).create();
  props.setProperty(PROP_DOWNLOAD_WORKER_TRIG, trig.getUniqueId());
}

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function ensureSheetWithHeaders(sheetName, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getSubscriptionsSheet() {
  const sheet = ensureSheetWithHeaders(SUBSCRIPTIONS_SHEET_NAME, SUBSCRIPTIONS_HEADERS);
  migrateLegacySubscriptionsToSheet(sheet);
  return sheet;
}

function migrateLegacySubscriptionsToSheet(sheet) {
  if (sheet.getLastRow() > 1) return;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(LEGACY_PROP_SUBSCRIPTIONS);
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const entries = Object.entries(parsed || {});
  if (entries.length === 0) {
    props.deleteProperty(LEGACY_PROP_SUBSCRIPTIONS);
    return;
  }
  const rows = entries.map(([url, data]) => ([
    url,
    (data && data.title) || url,
    (data && data.imageUrl) || '',
    data && data.subscribeDate ? new Date(data.subscribeDate) : new Date(),
    STATUS_ACTIVE
  ]));
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  props.deleteProperty(LEGACY_PROP_SUBSCRIPTIONS);
}

function parseSubscribeDate(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (value == null || value === '') return 0;
  const parsed = new Date(value).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

function getSubscriptionRows() {
  const sheet = getSubscriptionsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return values.map((row, idx) => ({
    rowIndex: idx + 2,
    url: String(row[0] || '').trim(),
    title: String(row[1] || '').trim(),
    imageUrl: String(row[2] || '').trim(),
    subscribeDate: parseSubscribeDate(row[3]),
    status: String(row[4] || '').trim()
  })).filter(row => row.url);
}

function getSubscriptions() {
  const activeRows = getSubscriptionRows().filter(row => row.status === STATUS_ACTIVE);
  const subs = {};
  activeRows.forEach(row => {
    subs[row.url] = {
      title: row.title || row.url,
      imageUrl: row.imageUrl || '',
      subscribeDate: row.subscribeDate || 0
    };
  });
  return subs;
}

function syncActiveSubscriptionsMetadata(subs) {
  const sheet = getSubscriptionsSheet();
  const rows = getSubscriptionRows();
  rows.forEach(row => {
    if (row.status !== STATUS_ACTIVE) return;
    const sub = subs[row.url];
    if (!sub) return;
    const nextTitle = sub.title || row.url;
    const nextImage = sub.imageUrl || '';
    if (nextTitle !== row.title || nextImage !== row.imageUrl) {
      sheet.getRange(row.rowIndex, 2, 1, 2).setValues([[nextTitle, nextImage]]);
    }
  });
}

/** Returns array of { url, title, imageUrl, subscribeDate } */
function getSubscriptionsList() {
  return getSubscriptionRows()
    .filter(row => row.status === STATUS_ACTIVE)
    .map(row => ({
      url: row.url,
      title: row.title || row.url,
      imageUrl: row.imageUrl || '',
      subscribeDate: row.subscribeDate || 0
    }));
}

/** Called from sidebar – add a new subscription */
function addSubscription(rssUrl, title, imageUrl) {
  const url = String(rssUrl || '').trim();
  if (!url) return { success: false, message: 'כתובת RSS חסרה' };

  const sheet = getSubscriptionsSheet();
  const rows = getSubscriptionRows();
  const existing = rows.find(row => row.url === url);

  if (existing && existing.status === STATUS_ACTIVE) {
    return { success: false, message: 'כבר מנוי לפודקאסט זה' };
  }

  const values = [
    url,
    title || url,
    imageUrl || '',
    new Date(),
    STATUS_ACTIVE
  ];

  if (existing) {
    sheet.getRange(existing.rowIndex, 1, 1, 5).setValues([values]);
  } else {
    sheet.appendRow(values);
  }

  return { success: true };
}

/**
 * Purpose: Let the user subscribe by pasting a podcast RSS feed URL from the sidebar.
 * Operation: Normalizes the URL (HTTPS by default), fetches and parses the feed with
 * `parseRSS` to verify it and read channel title and artwork, then saves via `addSubscription`.
 */
function addSubscriptionFromRssUrl(rssUrlInput) {
  try {
    let url = (rssUrlInput || '').trim();
    if (!url) {
      return { success: false, error: 'יש להזין כתובת RSS' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'נתמך רק קישור HTTP או HTTPS' };
    }
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url.replace(/^\/+/, '');
    }

    const data = parseRSS(url);
    const added = addSubscription(url, data.title, data.imageUrl);
    if (!added.success) {
      return { success: false, error: added.message || 'לא ניתן להוסיף מנוי' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'לא ניתן לטעון את הפיד' };
  }
}

/** Called from sidebar – remove a subscription */
function removeSubscription(rssUrl) {
  const url = String(rssUrl || '').trim();
  const sheet = getSubscriptionsSheet();
  const rows = getSubscriptionRows();
  const row = rows.find(r => r.url === url && r.status === STATUS_ACTIVE);
  if (row) {
    sheet.getRange(row.rowIndex, 5).setValue(STATUS_CANCELLED);
  }
  return { success: true };
}

// ============================================================
// DOWNLOADED URL TRACKING
// ============================================================

function getDownloadsSheet() {
  const sheet = ensureSheetWithHeaders(DOWNLOADS_SHEET_NAME, DOWNLOADS_HEADERS);
  migrateLegacyDownloadsToSheet(sheet);
  return sheet;
}

function migrateLegacyDownloadsToSheet(sheet) {
  if (sheet.getLastRow() > 1) return;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(LEGACY_PROP_DOWNLOADED);
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const rows = (Array.isArray(parsed) ? parsed : []).map(url => [String(url || '').trim()]).filter(r => r[0]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 1).setValues(rows);
  }
  props.deleteProperty(LEGACY_PROP_DOWNLOADED);
}

function getDownloadedSet() {
  const sheet = getDownloadsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const urls = values.map(row => String(row[0] || '').trim()).filter(Boolean);
  return new Set(urls);
}

function saveDownloadedSet(set) {
  const sheet = getDownloadsSheet();
  const arr = Array.from(set).filter(Boolean);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).clearContent();
  }
  if (arr.length > 0) {
    const rows = arr.map(url => [url]);
    sheet.getRange(2, 1, rows.length, 1).setValues(rows);
  }
}

function markDownloaded(url, set) {
  if (set) {
    set.add(url);
    return;
  }
  const downloaded = getDownloadedSet();
  downloaded.add(url);
  saveDownloadedSet(downloaded);
}

function isDownloaded(url, set) {
  if (set) return set.has(url);
  return getDownloadedSet().has(url);
}

function unmarkDownloaded(url, set) {
  if (set) {
    set.delete(url);
    return;
  }
  const downloaded = getDownloadedSet();
  if (!downloaded.delete(url)) return;
  saveDownloadedSet(downloaded);
}

function ensureDownloadQueueSheet() {
  const sheet = ensureSheetWithHeaders(DOWNLOAD_QUEUE_SHEET_NAME, DOWNLOAD_QUEUE_HEADERS);
  if (!sheet.isSheetHidden()) {
    sheet.hideSheet();
  }
  return sheet;
}

function enqueueDownloadJob(payload) {
  const sheet = ensureDownloadQueueSheet();
  sheet.appendRow([JSON.stringify(payload || {})]);
}

function getDownloadQueueLength() {
  const sheet = ensureDownloadQueueSheet();
  return Math.max(0, sheet.getLastRow() - 1);
}

function peekDownloadQueueHead() {
  const sheet = ensureDownloadQueueSheet();
  if (sheet.getLastRow() < 2) return null;
  const raw = String(sheet.getRange(2, 1).getValue() || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function updateDownloadQueueHead(payload) {
  const sheet = ensureDownloadQueueSheet();
  if (sheet.getLastRow() < 2) return;
  sheet.getRange(2, 1).setValue(JSON.stringify(payload || {}));
}

function shiftDownloadQueue() {
  const sheet = ensureDownloadQueueSheet();
  if (sheet.getLastRow() < 2) return;
  sheet.deleteRow(2);
}

/**
 * Purpose: Prevent duplicate manual-download requests by checking whether a given episode URL
 *   is already present anywhere in the download queue sheet.
 * Operation: Reads all rows in the queue sheet, parses each JSON payload, and compares
 *   `episodeUrl` against the target URL. Returns true on first match, false if not found.
 * @param {string} episodeUrl - The episode audio URL to search for in the queue.
 * @returns {boolean} - True if the URL exists in the queue, false otherwise.
 */
function isEpisodeInQueue(episodeUrl) {
  const sheet = ensureDownloadQueueSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    try {
      const job = JSON.parse(String(values[i][0] || '').trim());
      if (job && job.episodeUrl === episodeUrl) return true;
    } catch (_) { /* skip malformed rows */ }
  }
  return false;
}

/**
 * Returns true if an audio file for this episode still exists in the podcast folder
 * (single file or first part of a chunked download).
 */
function episodeAudioFilesExistInDrive(podcastTitle, episodeTitle, pubDate, runT0) {
  try {
    debugStep(
      'episodeAudioFilesExistInDrive',
      debugSnippet(podcastTitle, 60) + ' / ' + debugSnippet(episodeTitle, 60),
      runT0
    );
    const folder = getPodcastFolder(podcastTitle || 'כללי');
    const d = pubDate instanceof Date ? pubDate : new Date(pubDate || Date.now());
    const singleName = buildFileName(episodeTitle, d);
    if (folder.getFilesByName(singleName).hasNext()) {
      debugStep('episodeAudioFilesExistInDrive: found', singleName, runT0);
      return true;
    }
    const partName = buildFileName(episodeTitle, d, 1);
    const hasPart = folder.getFilesByName(partName).hasNext();
    debugStep('episodeAudioFilesExistInDrive: part1', partName + ' exists=' + hasPart, runT0);
    return hasPart;
  } catch (_) {
    return true;
  }
}

/**
 * Manual downloads only: if the episode URL is marked downloaded but the expected file(s) are
 * missing from Drive, clear the flag so the user can fetch again. Automatic `podcastManager` does
 * not call this — the sheet URL list is the source of truth for auto runs (deleting files to free
 * space will not queue a re-download).
 */
function syncDownloadedFlagWithDrive(url, podcastTitle, episodeTitle, pubDate, downloadedSet, runT0) {
  if (!isDownloaded(url, downloadedSet)) return;
  debugStep('syncDownloadedFlagWithDrive: check', debugSnippet(episodeTitle, 80), runT0);
  const d = pubDate instanceof Date ? pubDate : (pubDate ? new Date(pubDate) : new Date());
  if (isNaN(d.getTime())) return;
  if (!episodeAudioFilesExistInDrive(podcastTitle, episodeTitle, d, runT0)) {
    debugStep('syncDownloadedFlagWithDrive: unmark (missing file)', debugSnippet(url, 80), runT0);
    unmarkDownloaded(url, downloadedSet);
  }
}

// ============================================================
// DRIVE HELPERS
// ============================================================

function getRootFolder() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function getPodcastFolder(podcastTitle) {
  const safeName = sanitizeFolderName(podcastTitle);
  const root = getRootFolder();
  const it = root.getFoldersByName(safeName);
  return it.hasNext() ? it.next() : root.createFolder(safeName);
}

function sanitizeFolderName(name) {
  return (name || 'podcast').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'podcast';
}

function sanitizeFileName(name) {
  return (name || '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

// ============================================================
// FILE NAMING
// ============================================================

function formatDateYYMMDD(date) {
  const d = new Date(date);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Purpose: Build a safe, dated filename for a downloaded podcast episode.
 * Operation: Formats the publication date as YYMMDD, sanitizes the episode title, and appends the
 *   given file extension (defaults to 'mp3'). The partNum parameter is kept for backward
 *   compatibility with any callers that might still reference it, but is no longer used by the
 *   Resumable Upload path (which always creates a single complete file).
 */
function buildFileName(episodeTitle, pubDate, ext) {
  const dateStr = formatDateYYMMDD(pubDate || new Date());
  const safeTitle = sanitizeFileName(episodeTitle) || 'פרק';
  const safeExt = (ext && /^[a-z0-9]+$/i.test(ext)) ? ext : 'mp3';
  return `${dateStr} ${safeTitle}.${safeExt}`;
}

// ============================================================
// LOGGING
// ============================================================

function writeLog(podcastTitle, episodeTitle, status, note, link) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['תאריך', 'פודקאסט', 'פרק', 'סטטוס', 'הערה', 'קישור']);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < 6) {
    sheet.getRange(1, 6).setValue('קישור');
  }
  sheet.appendRow([
    new Date(),
    podcastTitle || '',
    episodeTitle || '',
    status || '',
    note || '',
    link || ''
  ]);

  if (link) {
    const row = sheet.getLastRow();
    setLogLinkCell(sheet, row, link);
  }
}

function isHttpUrl(text) {
  return /^https?:\/\/\S+$/i.test(String(text || '').trim());
}

function setLogLinkCell(sheet, row, linkText) {
  const lines = String(linkText || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!lines.length) return;

  const cellText = lines.join('\n');
  const builder = SpreadsheetApp.newRichTextValue().setText(cellText);

  let cursor = 0;
  let hasAnyLink = false;
  lines.forEach(line => {
    if (isHttpUrl(line)) {
      builder.setLinkUrl(cursor, cursor + line.length, line);
      hasAnyLink = true;
    }
    cursor += line.length + 1; // include newline
  });

  if (hasAnyLink) {
    sheet.getRange(row, 6).setRichTextValue(builder.build());
  }
}

// ============================================================
// DOWNLOAD ENGINE
// ============================================================

/**
 * Purpose: OAuth token helper exposed so client-side UrlFetchApp calls inside this script can
 *   attach a valid Bearer token when calling Google APIs directly (e.g. Drive Resumable Upload).
 * Operation: Delegates to ScriptApp.getOAuthToken() which returns the token that already covers
 *   the scopes declared in appsscript.json — no extra setup required.
 */
function getOAuthToken() {
  return ScriptApp.getOAuthToken();
}

/**
 * Purpose: Detect the correct file extension for a podcast episode.
 * Operation: Inspects the URL path first (most reliable), then falls back to the Content-Type
 *   header returned by an optional HEAD-like probe. Supports mp3, m4a, mp4, ogg, opus, aac, wav.
 *   Returns 'mp3' as default if detection fails.
 * @param {string} url          - Episode download URL.
 * @param {Object} [headers]    - Optional response headers object from a prior probe request.
 * @returns {string}            - Lowercase file extension without the leading dot.
 */
function detectFileExtension(url, headers) {
  const knownExts = ['mp3', 'm4a', 'mp4', 'ogg', 'opus', 'aac', 'wav'];
  // 1. Try to read from URL path (strip query string first)
  try {
    const path = String(url || '').split('?')[0].split('#')[0].toLowerCase();
    const lastSeg = path.split('/').pop() || '';
    const dotIdx = lastSeg.lastIndexOf('.');
    if (dotIdx >= 0) {
      const ext = lastSeg.slice(dotIdx + 1);
      if (knownExts.includes(ext)) return ext;
    }
  } catch (_) { /* ignore */ }

  // 2. Try Content-Type header
  if (headers) {
    const ct = String(getHeaderCaseInsensitive(headers, 'Content-Type') || '').toLowerCase();
    if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('mpeg4')) return 'm4a';
    if (ct.includes('mp3') || ct.includes('mpeg')) return 'mp3';
    if (ct.includes('ogg')) return 'ogg';
    if (ct.includes('opus')) return 'opus';
    if (ct.includes('aac')) return 'aac';
    if (ct.includes('wav')) return 'wav';
  }

  return 'mp3'; // safe default
}

/**
 * Purpose: Main entry point – downloads one episode and saves it as a single complete file in the
 *   given Google Drive folder using the Resumable Upload API.
 * Operation: Detects file extension and content length, then delegates entirely to
 *   downloadResumable which handles the chunked download+upload loop, session persistence across
 *   worker re-invocations, and time-budget enforcement.
 * @returns {Array<{fileId, fileName, driveUrl}>} – always a single-element array.
 */
function downloadEpisodeToFolder(episodeUrl, episodeTitle, pubDate, folder, description, options) {
  const runT0 = options && options.runT0;
  debugStep(
    'downloadEpisodeToFolder: start',
    debugSnippet(episodeTitle, 80) + ' | ' + debugSnippet(episodeUrl, 120),
    runT0
  );
  return downloadResumable(episodeUrl, episodeTitle, pubDate, folder, description, options);
}

function getHeaderCaseInsensitive(headers, key) {
  const wanted = String(key || '').toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === wanted) return headers[keys[i]];
  }
  return null;
}

/**
 * Purpose: Initiate a Google Drive Resumable Upload session for a new file.
 * Operation: Sends a POST to the Drive API v3 resumable upload endpoint with the file metadata
 *   (name, mimeType, parent folder, description). The API returns a session URL in the Location
 *   header; subsequent PUT requests to that URL upload the actual file bytes chunk by chunk.
 *   Uses `getOAuthToken()` for authentication — no extra GCP project setup needed.
 * @param {string} fileName     - Target filename in Drive (including extension).
 * @param {string} mimeType     - MIME type of the file (e.g. 'audio/mpeg').
 * @param {string} folderId     - Google Drive folder ID where the file will be created.
 * @param {string} description  - Optional file description.
 * @returns {string}            - Session URL to use for subsequent chunk uploads.
 */
function createResumableUploadSession(fileName, mimeType, folderId, description) {
  const token = getOAuthToken();
  const metadata = { name: fileName, mimeType, parents: [folderId] };
  if (description) metadata.description = description;

  const resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType
      },
      payload: JSON.stringify(metadata),
      muteHttpExceptions: true
    }
  );

  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error(`יצירת סשן העלאה נכשלה: HTTP ${code} – ${resp.getContentText().slice(0, 200)}`);
  }

  const location = getHeaderCaseInsensitive(resp.getHeaders(), 'Location');
  if (!location) {
    throw new Error('שרת Drive לא החזיר Location header עבור סשן ההעלאה');
  }
  return location;
}

/**
 * Purpose: Query a Drive Resumable Upload session to find out how many bytes were already received.
 * Operation: Sends an empty PUT with `Content-Range: *‌/*` (total size unknown) to the session URL.
 *   The Drive server responds with 308 Resume Incomplete and a Range header indicating the last
 *   received byte. Returns 0 if no bytes were received yet (the Range header is absent).
 *   This is called at the start of a resumed worker run to safely skip bytes already uploaded.
 * @param {string} sessionUrl   - The Drive Resumable Upload session URL.
 * @returns {number}            - Number of bytes already confirmed by Drive (next byte to upload).
 */
function queryResumableSessionProgress(sessionUrl) {
  const token = getOAuthToken();
  // NOTE: Google Apps Script does not allow setting the Content-Length header manually.
  // To send a status-query request with zero bytes, we pass an empty Uint8Array as the payload.
  // UrlFetchApp will compute Content-Length: 0 automatically.
  const resp = UrlFetchApp.fetch(sessionUrl, {
    method: 'put',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Range': 'bytes */*'
    },
    payload: new Uint8Array(0),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  // 308 = Resume Incomplete (normal mid-upload query response)
  if (code === 308) {
    const range = getHeaderCaseInsensitive(resp.getHeaders(), 'Range');
    if (!range) return 0; // nothing received yet
    const m = String(range).match(/bytes=0-(\d+)/);
    return m ? parseInt(m[1], 10) + 1 : 0;
  }
  // 200/201 = already complete (should not happen if we are querying mid-upload)
  if (code === 200 || code === 201) return -1; // sentinel: upload already finished
  throw new Error(`שאילתת מצב סשן ההעלאה נכשלה: HTTP ${code}`);
}

/**
 * Purpose: Download a podcast episode from its source URL and upload it to Google Drive as a
 *   single, complete file using the Drive Resumable Upload API.
 * Operation:
 *   1. Detects the correct file extension and MIME type from the URL / Content-Type header.
 *   2. Creates (or resumes) a Drive Resumable Upload session.
 *   3. Enters a loop: downloads CHUNK_SIZE bytes from the podcast server using a Range request,
 *      immediately uploads that chunk to the session URL with the correct Content-Range header,
 *      then releases the chunk from memory.
 *   4. For servers that do not advertise Content-Length the total size is sent as '*' for all
 *      intermediate chunks and only the real byte count on the final chunk.
 *   5. If the time budget is exceeded mid-loop, saves the session URL (and byte offset) to the
 *      job payload and throws TIME_BUDGET_EXCEEDED so the caller can reschedule.
 *   6. On success returns a single-element array identical in shape to the old downloadChunked
 *      return value: [{ fileId, fileName, driveUrl }].
 * @param {string}   episodeUrl   - Direct audio download URL.
 * @param {string}   episodeTitle - Episode title (used for the filename).
 * @param {Date}     pubDate      - Publication date (used for the filename date prefix).
 * @param {Folder}   folder       - Google Drive Folder object to upload into.
 * @param {string}   description  - Optional file description stored on the Drive file.
 * @param {Object}   [options]    - runT0, shouldStop(), resumeOffset, resumeSessionUrl.
 * @returns {Array<{fileId, fileName, driveUrl}>}
 */
function downloadResumable(episodeUrl, episodeTitle, pubDate, folder, description, options) {
  const runT0 = options && options.runT0;
  const shouldStop = (options && typeof options.shouldStop === 'function') ? options.shouldStop : () => false;

  // --- 1. Determine file extension and MIME type ---
  debugStep('downloadResumable: probe for extension/size', debugSnippet(episodeUrl, 120), runT0);
  let totalSize = null;
  let ext = 'mp3';
  try {
    const probeResp = UrlFetchApp.fetch(episodeUrl, {
      headers: { Range: 'bytes=0-0' },
      followRedirects: true,
      muteHttpExceptions: true
    });
    const probeHeaders = probeResp.getHeaders() || {};
    const fromRange = parseTotalSizeFromContentRange(probeHeaders);
    const fromCl = parseContentLength(probeHeaders);
    totalSize = fromRange !== null ? fromRange : fromCl;
    ext = detectFileExtension(episodeUrl, probeHeaders);
    debugStep('downloadResumable: probe done', `size=${totalSize} ext=${ext}`, runT0);
  } catch (e) {
    debugStep('downloadResumable: probe failed (continuing without size)', e.message || String(e), runT0);
  }

  const mimeTypeMap = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav' };
  const mimeType = mimeTypeMap[ext] || 'audio/mpeg';
  const fileName = buildFileName(episodeTitle, pubDate, ext);
  const token = getOAuthToken();

  // --- 2. Create or resume a Drive Resumable Upload session ---
  let sessionUrl = (options && options.resumeSessionUrl) || null;
  let uploadedBytes = 0;

  if (sessionUrl) {
    // Resuming from a previous worker run: ask Drive how far it got
    debugStep('downloadResumable: querying existing session progress', debugSnippet(sessionUrl, 120), runT0);
    try {
      const confirmed = queryResumableSessionProgress(sessionUrl);
      if (confirmed === -1) {
        // Session already complete – this should not normally happen, but handle it gracefully.
        debugStep('downloadResumable: session already finished (unexpected)', null, runT0);
        // We cannot retrieve fileId from the session URL at this point; fall through to create new.
        sessionUrl = null;
        uploadedBytes = 0;
      } else {
        uploadedBytes = confirmed;
        debugStep('downloadResumable: resuming from byte', String(uploadedBytes), runT0);
      }
    } catch (e) {
      // Session may have expired (Drive sessions last ~1 week). Start fresh.
      debugStep('downloadResumable: session query failed, starting new session', e.message || String(e), runT0);
      sessionUrl = null;
      uploadedBytes = 0;
      // CRITICAL: also clear the stale resumeOffset so the download loop starts from byte 0
      // when a new session is created below (otherwise the old offset would produce a
      // Content-Range mismatch → HTTP 503 from Drive).
      if (options) options.resumeOffset = 0;
    }
  }

  if (!sessionUrl) {
    debugStep('downloadResumable: creating new upload session', `file=${debugSnippet(fileName, 80)} folder=${folder.getId()}`, runT0);
    sessionUrl = createResumableUploadSession(fileName, mimeType, folder.getId(), description);
    uploadedBytes = 0;
    debugStep('downloadResumable: session created', debugSnippet(sessionUrl, 80), runT0);
  }

  // --- 3. Chunk download + upload loop ---
  let offset = (options && typeof options.resumeOffset === 'number' && options.resumeOffset >= 0)
    ? options.resumeOffset
    : uploadedBytes; // align download cursor with confirmed uploads

  let chunkIndex = 0;
  let fileId = null;
  let driveUrl = null;

  while (true) {
    if (shouldStop()) {
      debugStep('downloadResumable: shouldStop before chunk', `offset=${offset}`, runT0);
      const err = new Error('TIME_BUDGET_EXCEEDED');
      err.code = 'TIME_BUDGET_EXCEEDED';
      err.resumeOffset = offset;
      err.resumeSessionUrl = sessionUrl;
      throw err;
    }

    const rangeEnd = totalSize
      ? Math.min(offset + CHUNK_SIZE - 1, totalSize - 1)
      : offset + CHUNK_SIZE - 1;

    debugStep(
      'downloadResumable: download chunk',
      `chunk=${chunkIndex} bytes=${offset}-${rangeEnd}` + (totalSize != null ? ` of ${totalSize}` : ''),
      runT0
    );

    // Download chunk from podcast server
    let downloadResp;
    try {
      downloadResp = UrlFetchApp.fetch(episodeUrl, {
        headers: { Range: `bytes=${offset}-${rangeEnd}` },
        followRedirects: true,
        muteHttpExceptions: true
      });
    } catch (e) {
      throw new Error(`שגיאת רשת בהורדת chunk ${chunkIndex}: ${e.message}`);
    }

    const downloadCode = downloadResp.getResponseCode();
    debugStep('downloadResumable: downloaded chunk', `chunk=${chunkIndex} HTTP=${downloadCode}`, runT0);

    // chunkPayload is what we pass to Drive. For HTTP 206 we use getBlob() to keep data
    // in the Java-side heap (zero JS-heap expansion → no OOM). For the rare HTTP 200 case
    // (server ignores Range) we still need getContent() to learn the total file size.
    let chunkPayload; // Blob for 206 / byte-array for 200 / Uint8Array for 416
    let chunkLen;     // exact byte count of this chunk (used for Content-Range header)
    let isLastChunk = false;

    if (downloadCode === 200 && chunkIndex === 0) {
      // Server does not support Range – received the whole file in one shot.
      // We must use getContent() here because we need the byte count to set totalSize.
      const fullBytes = downloadResp.getContent();
      downloadResp = null;
      isLastChunk = true;
      chunkLen = fullBytes.length;
      totalSize = chunkLen;
      chunkPayload = fullBytes;
      debugStep('downloadResumable: server sent full file (no Range support)', `size=${totalSize}`, runT0);
    } else if (downloadCode === 206) {
      // --- Memory-efficient path: keep bytes in Java-side Blob, never expand to JS array ---
      // Derive the actual chunk length from the response Content-Length header first
      // (always present in a 206 response per RFC 7233). Fall back to mathematical
      // calculation from the requested range, which is exact when totalSize is known.
      // Only as an absolute last resort do we touch getBytes() – but that path should
      // never be reached in practice because we always probe for totalSize at the start.
      const dlHeaders = downloadResp.getHeaders() || {};
      const headerLen = parseContentLength(dlHeaders);
      const blob = downloadResp.getBlob();
      downloadResp = null; // release HTTP response object immediately
      chunkPayload = blob;

      if (headerLen !== null) {
        // Best case: Content-Length header is authoritative and costs nothing.
        chunkLen = headerLen;
      } else if (totalSize !== null) {
        // Second choice: mathematical derivation from the known total size.
        chunkLen = Math.min(CHUNK_SIZE, totalSize - offset);
      } else {
        // Last resort: must inspect the blob. This loads it into JS-heap but totalSize
        // is normally known from the probe step, so this path is rarely reached.
        chunkLen = blob.getBytes().length;
      }

      if (totalSize && offset + chunkLen >= totalSize) isLastChunk = true;
      if (!totalSize && chunkLen < CHUNK_SIZE) {
        isLastChunk = true;
        totalSize = offset + chunkLen;
      }
    } else if (downloadCode === 416) {
      // Range Not Satisfiable – we have already downloaded everything.
      downloadResp = null;
      isLastChunk = true;
      chunkLen = 0;
      chunkPayload = new Uint8Array(0);
    } else {
      downloadResp = null;
      throw new Error(`HTTP ${downloadCode} בעת הורדת chunk ${chunkIndex} מהשרת`);
    }

    const isKnownTotal = totalSize !== null;
    const contentRangeHeader = isLastChunk
      ? `bytes ${offset}-${offset + chunkLen - 1}/${offset + chunkLen}`
      : (isKnownTotal
          ? `bytes ${offset}-${offset + chunkLen - 1}/${totalSize}`
          : `bytes ${offset}-${offset + chunkLen - 1}/*`);

    debugStep(
      'downloadResumable: upload chunk',
      `chunk=${chunkIndex} chunkLen=${chunkLen} Content-Range=${contentRangeHeader}`,
      runT0
    );

    // Upload chunk to Drive Resumable session.
    // Passing chunkPayload (a Blob for 206 responses) directly avoids any JS-heap expansion:
    // UrlFetchApp reads the Blob bytes natively without exposing them to the GAS JS engine.
    // Drive validates the byte count against Content-Range server-side and returns HTTP 400
    // if the payload is shorter than declared – so corrupt data can never be committed.
    let uploadResp;
    try {
      uploadResp = UrlFetchApp.fetch(sessionUrl, {
        method: 'put',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Range': contentRangeHeader,
          'Content-Type': mimeType
        },
        payload: chunkPayload,
        muteHttpExceptions: true
      });
    } catch (e) {
      throw new Error(`שגיאת רשת בהעלאת chunk ${chunkIndex} לדרייב: ${e.message}`);
    }
    chunkPayload = null; // allow GC

    const uploadCode = uploadResp.getResponseCode();
    debugStep('downloadResumable: uploaded chunk', `chunk=${chunkIndex} HTTP=${uploadCode}`, runT0);

    if (uploadCode === 200 || uploadCode === 201) {
      // Drive finished receiving the file
      let fileData;
      try { fileData = JSON.parse(uploadResp.getContentText()); } catch (_) { fileData = {}; }
      fileId = fileData.id || null;
      if (!fileId) {
        // Fallback: find the file by name in the folder
        const it = folder.getFilesByName(fileName);
        if (it.hasNext()) fileId = it.next().getId();
      }
      driveUrl = fileId ? `https://drive.google.com/file/d/${fileId}/view` : '';
      debugStep('downloadResumable: upload complete', `fileId=${fileId}`, runT0);
      break;
    } else if (uploadCode === 308) {
      // Resume Incomplete – Drive acknowledged this chunk, continue with the next.
      // Use the Range header returned by Drive (if present) as the authoritative new offset.
      // This makes the loop resilient to any off-by-one in our chunkLen calculation.
      const rangeHeader = (uploadResp.getAllHeaders() || {})['Range'] || null;
      uploadResp = null;
      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d+)/);
        if (m) {
          offset = parseInt(m[2], 10) + 1; // Drive confirmed up to this byte inclusive
          debugStep('downloadResumable: next offset (from Drive Range header)', String(offset), runT0);
        } else {
          offset += chunkLen;
        }
      } else {
        offset += chunkLen;
      }
      chunkIndex++;
      continue;
    } else {
      throw new Error(`HTTP ${uploadCode} בעת העלאת chunk ${chunkIndex} לדרייב: ${uploadResp.getContentText().slice(0, 200)}`);
    }
  }

  if (!fileId) {
    throw new Error('ההעלאה הושלמה אך לא ניתן לאתר את ה-fileId בדרייב');
  }

  debugStep('downloadResumable: finished', `file=${fileName} id=${fileId}`, runT0);
  return [{ fileId, fileName, driveUrl }];
}

function parseContentLength(headers) {
  const raw = getHeaderCaseInsensitive(headers, 'Content-Length');
  if (raw == null) return null;
  const n = parseInt(String(raw), 10);
  return isNaN(n) ? null : n;
}

function parseTotalSizeFromContentRange(headers) {
  const raw = getHeaderCaseInsensitive(headers, 'Content-Range');
  if (!raw) return null;
  const m = String(raw).match(/\/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

// ensureFullResponseBytes, fetchContentLength, and downloadDirect have been removed.
// Their logic is now handled inside downloadResumable which probes size/extension in one
// Range request and then streams each chunk directly to the Drive Resumable Upload session.


// ============================================================
// RSS PARSING
// ============================================================

/**
 * Parses an RSS feed and returns { title, imageUrl, episodes[] }.
 * If subscriptionDateMs is provided, this stops early on the first item whose pubDate is
 * older than or equal to the subscription date (assumes feed items are newest-first).
 * episodes: { title, date, description, url }
 */
function parseRSS(xmlUrl, runT0, subscriptionDateMs) {
  debugStep('parseRSS: UrlFetch start', debugSnippet(xmlUrl, 200), runT0);
  const resp = UrlFetchApp.fetch(xmlUrl, { followRedirects: true, muteHttpExceptions: true });
  debugStep('parseRSS: UrlFetch done', 'HTTP ' + resp.getResponseCode(), runT0);
  if (resp.getResponseCode() >= 400) {
    throw new Error(`לא ניתן לטעון RSS: HTTP ${resp.getResponseCode()}`);
  }

  const rawText = resp.getContentText();
  debugStep('parseRSS: body length', String(rawText.length) + ' chars', runT0);
  const feed = sanitizeXmlForParsing(rawText);
  debugStep('parseRSS: XmlService.parse start', null, runT0);
  const doc = XmlService.parse(feed);
  debugStep('parseRSS: XmlService.parse done', null, runT0);
  const root = doc.getRootElement();
  const channel = root.getChild('channel');
  if (!channel) throw new Error('פורמט RSS לא תקין – חסר אלמנט channel');

  const itunesNs = XmlService.getNamespace('http://www.itunes.com/dtds/podcast-1.0.dtd');

  // Podcast-level artwork
  let imageUrl = '';
  const imgEl = channel.getChild('image');
  if (imgEl) imageUrl = imgEl.getChildText('url') || '';
  if (!imageUrl) {
    try {
      const itunesImg = channel.getChild('image', itunesNs);
      if (itunesImg) imageUrl = itunesImg.getAttribute('href')?.getValue() || '';
    } catch (_) { /* namespace not present */ }
  }

  const podcastTitle = channel.getChildText('title') || 'ללא שם';

  const episodes = [];
  const items = channel.getChildren('item');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const dateText = item.getChildText('pubDate') || '';
    if (subscriptionDateMs != null) {
      const ts = new Date(dateText).getTime();
      if (isNaN(ts)) {
        continue;
      }
      if (ts <= subscriptionDateMs) {
        break;
      }
    }

    const encEl = item.getChild('enclosure');
    const url = encEl?.getAttribute('url')?.getValue() || '';
    if (!url) continue;

    let description = '';
    try {
      const descEl = item.getChild('description');
      description = descEl ? descEl.getValue() : '';
      description = description.replace(/<[^>]*>/g, '').trim().slice(0, 800);
    } catch (_) { /* ignore */ }

    episodes.push({
      title: (item.getChildText('title') || 'ללא שם').trim(),
      date: dateText,
      description,
      url
    });
  }

  debugStep('parseRSS: items', String(episodes.length) + ' episodes', runT0);
  return { title: podcastTitle, imageUrl, episodes };
}

function sanitizeXmlForParsing(xmlText) {
  return String(xmlText || '').replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    '&amp;'
  );
}

// ============================================================
// SIDEBAR-CALLABLE SERVER FUNCTIONS
// ============================================================

/** Returns podcast info (description and link) for a given RSS URL */
function fetchPodcastInfo(rssUrl) {
  try {
    const resp = UrlFetchApp.fetch(rssUrl, { followRedirects: true, muteHttpExceptions: true });
    if (resp.getResponseCode() >= 400) return { success: false, error: 'HTTP ' + resp.getResponseCode() };
    const feed = sanitizeXmlForParsing(resp.getContentText());
    const doc = XmlService.parse(feed);
    const channel = doc.getRootElement().getChild('channel');
    if (!channel) return { success: false, error: 'פורמט RSS לא תקין' };
    
    let description = '';
    try {
      const descEl = channel.getChild('description');
      if (descEl) description = descEl.getValue().trim();
    } catch(e) {}
    
    let link = '';
    try {
      const linkEl = channel.getChild('link');
      if (linkEl) link = linkEl.getValue().trim();
    } catch(e) {}

    return { success: true, description: description, link: link };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Returns episode list for a given RSS URL */
function fetchEpisodeList(rssUrl) {
  try {
    const data = parseRSS(rssUrl);
    return { success: true, title: data.title, imageUrl: data.imageUrl, episodes: data.episodes };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Purpose: Handle a manual "Download to Drive" request from the sidebar.
 * Operation: Instead of downloading inline (which would hit the 6-minute hard execution limit
 *   for large files), this function enqueues the episode into the hidden download queue sheet
 *   and immediately schedules `downloadWorker` to run. The worker handles the actual chunked
 *   download with soft-stop and cross-run resume, exactly like automatic downloads.
 *   Returns { success: true, queued: true } so the sidebar can show a "queued" state without
 *   blocking the UI thread waiting for the download to finish.
 * @param {Object} episodeData - { url, title, date, description, podcastTitle }
 * @returns {{ success: boolean, queued?: boolean, alreadyQueued?: boolean,
 *             alreadyDownloaded?: boolean, error?: string, driveFull?: boolean }}
 */
function downloadEpisode(episodeData) {
  let runT0;
  try {
    if (!episodeData || !episodeData.url) {
      return { success: false, error: 'נתוני הפרק חסרים' };
    }

    runT0 = Date.now();
    debugStep('downloadEpisode (sidebar): start', debugSnippet(episodeData.url, 150), runT0);
    const pubDate = episodeData.date ? new Date(episodeData.date) : new Date();

    // Sync downloaded flag with Drive (manual-only: if file was deleted, allow re-download)
    syncDownloadedFlagWithDrive(
      episodeData.url,
      episodeData.podcastTitle || 'כללי',
      episodeData.title || 'פרק',
      pubDate,
      undefined,
      runT0
    );

    if (isDownloaded(episodeData.url)) {
      debugStep('downloadEpisode (sidebar): already downloaded', null, runT0);
      return { success: false, alreadyDownloaded: true, error: 'הפרק כבר הורד בעבר' };
    }

    // Guard against double-tapping the button: check if the URL is already queued
    if (isEpisodeInQueue(episodeData.url)) {
      debugStep('downloadEpisode (sidebar): already in queue', null, runT0);
      return { success: true, queued: true, alreadyQueued: true };
    }

    // Enqueue the job with manualDownload=true so the worker logs it as "הורד ידנית"
    enqueueDownloadJob({
      podcastTitle: episodeData.podcastTitle || 'כללי',
      episodeUrl:   episodeData.url,
      episodeTitle: episodeData.title || 'פרק',
      pubDate:      pubDate.toISOString(),
      description:  episodeData.description || '',
      manualDownload: true
    });

    // Fire the worker immediately (1 ms delay = as soon as possible)
    scheduleDownloadWorkerAfterMs(60 * 1000);

    debugStep(
      'downloadEpisode (sidebar): enqueued and worker scheduled',
      debugSnippet(episodeData.url, 120),
      runT0
    );
    return { success: true, queued: true };

  } catch (e) {
    debugStep('downloadEpisode (sidebar): catch', (e.message || String(e)).slice(0, 200), runT0);
    const isDriveFull = (e.message || '').toLowerCase().includes('storage');
    let userMessage = e.message;
    if (isDriveFull) userMessage = 'Drive מלא – הורדה נכשלה';
    writeLog(episodeData?.podcastTitle || '', episodeData?.title || '', 'שגיאה', userMessage);
    return { success: false, error: userMessage, driveFull: isDriveFull };
  }
}

/** iTunes podcast search – runs server-side to bypass client network restrictions */
function searchPodcasts(query) {
  try {
    const url = `https://itunes.apple.com/search?media=podcast&term=${encodeURIComponent(query)}&limit=20`;
    const resp = UrlFetchApp.fetch(url, { followRedirects: true, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      return { success: false, error: `שגיאת חיפוש: HTTP ${resp.getResponseCode()}` };
    }
    const data = JSON.parse(resp.getContentText());
    const subs = getSubscriptions();

    const results = (data.results || [])
      .filter(r => r.feedUrl)
      .map(r => ({
        trackName: r.trackName || '',
        artistName: r.artistName || '',
        artworkUrl: r.artworkUrl100 || r.artworkUrl60 || '',
        feedUrl: r.feedUrl,
        genre: r.primaryGenreName || '',
        isSubscribed: !!subs[r.feedUrl]
      }));

    return { success: true, results };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// OPML IMPORT
// ============================================================

function importOPML(opmlText) {
  try {
    const doc = XmlService.parse(sanitizeXmlForParsing(opmlText));
    const root = doc.getRootElement();
    const body = root.getChild('body');
    if (!body) return { success: false, error: 'קובץ OPML לא תקין – חסר אלמנט body' };

    const feeds = [];
    collectFeedsFromOutlines(body, feeds);

    if (feeds.length === 0) {
      return { success: false, error: 'לא נמצאו feeds בקובץ ה-OPML' };
    }

    let added = 0, skipped = 0;

    feeds.forEach(feed => {
      const result = addSubscription(feed.url, feed.title || feed.url, '');
      if (result.success) {
        added++;
      } else {
        skipped++;
      }
    });

    return { success: true, added, skipped };
  } catch (e) {
    return { success: false, error: `שגיאה בניתוח OPML: ${e.message}` };
  }
}

function collectFeedsFromOutlines(parentEl, feeds) {
  parentEl.getChildren('outline').forEach(outline => {
    const xmlUrl = outline.getAttribute('xmlUrl')?.getValue();
    if (xmlUrl) {
      feeds.push({
        url: xmlUrl,
        title:
          outline.getAttribute('text')?.getValue() ||
          outline.getAttribute('title')?.getValue() ||
          xmlUrl
      });
    }
    // Recurse into category outlines
    collectFeedsFromOutlines(outline, feeds);
  });
}

// ============================================================
// OPML EXPORT
// ============================================================

function exportOPML() {
  try {
    const subs = getSubscriptions();
    const entries = Object.entries(subs);
    if (entries.length === 0) {
      return { success: false, error: 'אין מנויים לייצוא' };
    }

    const dateStr = formatDateYYMMDD(new Date());
    const escAttr = s => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<opml version="2.0">\n`;
    xml += `  <head>\n`;
    xml += `    <title>הסכתים – מנויים</title>\n`;
    xml += `    <dateCreated>${new Date().toUTCString()}</dateCreated>\n`;
    xml += `  </head>\n`;
    xml += `  <body>\n`;

    entries.forEach(([url, data]) => {
      const t = escAttr(data.title || url);
      xml += `    <outline type="rss" text="${t}" title="${t}" xmlUrl="${escAttr(url)}"/>\n`;
    });

    xml += `  </body>\n`;
    xml += `</opml>`;

    const folder = getRootFolder();
    const fileName = `subscriptions_${dateStr}.opml`;
    const blob = Utilities.newBlob(xml, 'text/x-opml; charset=UTF-8', fileName);
    const file = folder.createFile(blob);

    return {
      success: true,
      fileName,
      driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// MAIN PODCAST MANAGER (AUTOMATIC TRIGGER)
// ============================================================

function podcastManager() {
  const props = PropertiesService.getScriptProperties();
  const startTime = Date.now();
  const runT0 = startTime;
  debugStep('podcastManager: start', null, runT0);
  const downloadedSet = getDownloadedSet();
  debugStep('podcastManager: downloaded URL set', 'size=' + downloadedSet.size, runT0);
  const shouldStop = () => Date.now() - startTime >= SOFT_STOP_MS;
  let stopRequested = false;
  let resumeTriggerScheduled = false;
  deleteOneTimeTrigger();
  debugStep('podcastManager: deleteOneTimeTrigger done', null, runT0);

  // 2. Load resume state (if rescheduled)
  let resumeState = null;
  const resumeRaw = props.getProperty(PROP_RESUME);
  if (resumeRaw) {
    try { resumeState = JSON.parse(resumeRaw); } catch (_) { }
  }
  if (resumeState) {
    debugStep('podcastManager: resume state', debugSnippet(JSON.stringify(resumeState), 300), runT0);
  } else {
    debugStep('podcastManager: no resume state', null, runT0);
  }

  const checkpointProgress = (state, persistDownloads) => {
    debugStep('podcastManager: checkpoint', (persistDownloads ? 'persist ' : '') + debugSnippet(JSON.stringify(state), 200), runT0);
    props.setProperty(PROP_RESUME, JSON.stringify(state));
    if (persistDownloads) {
      saveDownloadedSet(downloadedSet);
      debugStep('podcastManager: saveDownloadedSet done', 'size=' + downloadedSet.size, runT0);
    }
  };

  const requestSoftStop = (state, persistDownloads) => {
    debugStep('podcastManager: requestSoftStop (soft time budget)', debugSnippet(JSON.stringify(state), 250), runT0);
    checkpointProgress(state, persistDownloads);
    if (!resumeTriggerScheduled) {
      ensureOneTimeTrigger(RESUME_TRIGGER_DELAY_MS);
      resumeTriggerScheduled = true;
      debugStep('podcastManager: scheduled one-time resume trigger', String(RESUME_TRIGGER_DELAY_MS) + 'ms', runT0);
    }
    stopRequested = true;
  };

  const subs = getSubscriptions();
  const subEntries = Object.entries(subs);
  debugStep('podcastManager: active subscriptions', 'count=' + subEntries.length, runT0);
  if (subEntries.length === 0) {
    debugStep('podcastManager: exit (no subscriptions)', null, runT0);
    saveDownloadedSet(downloadedSet);
    props.deleteProperty(PROP_RESUME);
    deleteOneTimeTrigger();
    if (getDownloadQueueLength() > 0) {
      scheduleDownloadWorkerAfterMs(60 * 1000);
    }
    props.setProperty(PROP_LAST_RUN, String(Date.now()));
    return;
  }

  let startPi = 0;
  let startEi = 0;
  if (resumeState) {
    if (resumeState.podcastUrl) {
      const idx = subEntries.findIndex(([url]) => url === resumeState.podcastUrl);
      if (idx >= 0) {
        startPi = idx;
        startEi = resumeState.episodeIndex || 0;
      }
    } else if (typeof resumeState.podcastIndex === 'number') {
      startPi = resumeState.podcastIndex;
      startEi = resumeState.episodeIndex || 0;
    }
  }

  let driveFull = false;

  for (let pi = startPi; pi < subEntries.length; pi++) {
    if (driveFull) break;

    const [rssUrl, subData] = subEntries[pi];
    const startEi_ = (pi === startPi) ? startEi : 0;
    debugStep(
      'podcastManager: podcast loop',
      `pi=${pi}/${subEntries.length} ` + debugSnippet(subData.title || rssUrl, 80),
      runT0
    );
    if (shouldStop()) {
      requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: 0 }, false);
      break;
    }

    // Fetch RSS
    let episodes = [];
    try {
      const parsed = parseRSS(rssUrl, runT0, subData.subscribeDate || 0);
      // Update cached title if podcast renamed itself
      if (parsed.title && parsed.title !== subData.title) {
        subs[rssUrl].title = parsed.title;
      }
      episodes = parsed.episodes;
      debugStep('podcastManager: episodes after date filter', 'count=' + episodes.length, runT0);
    } catch (e) {
      debugStep('podcastManager: parseRSS failed', e.message || String(e), runT0);
      writeLog(subData.title, '—', 'שגיאת RSS', e.message);
      continue;
    }
    if (shouldStop()) {
      requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: 0 }, false);
      break;
    }

    for (let ei = startEi_; ei < episodes.length; ei++) {
      const ep = episodes[ei];

      // ── Time check ──────────────────────────────────────────
      if (shouldStop()) {
        requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei, episodeUrl: ep.url }, false);
        break;
      }

      const folderTitle = subs[rssUrl].title || subData.title;
      const pubDate = ep.date ? new Date(ep.date) : new Date();
      debugStep(
        'podcastManager: episode',
        `ei=${ei} ` + debugSnippet(ep.title, 60),
        runT0
      );
      // No syncDownloadedFlagWithDrive here — auto skips by URL sheet alone (see comment on syncDownloadedFlagWithDrive).
      if (isDownloaded(ep.url, downloadedSet)) {
        debugStep('podcastManager: skip (already downloaded)', debugSnippet(ep.url, 100), runT0);
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 }, false);
        continue;
      }

      try {
        enqueueDownloadJob({
          podcastTitle: folderTitle,
          episodeUrl: ep.url,
          episodeTitle: ep.title,
          pubDate: pubDate.toISOString(),
          description: ep.description || ''
        });
        debugStep('podcastManager: enqueued episode', debugSnippet(ep.title, 80), runT0);
        resumeState = null;
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 }, false);
      } catch (e) {
        debugStep('podcastManager: enqueue error', (e.message || String(e)).slice(0, 200), runT0);
        const msg = e.message || '';
        if (msg.toLowerCase().includes('storage') || msg.toLowerCase().includes('quota')) {
          writeLog(subData.title, ep.title, 'שגיאה', 'נכשל בהכנסה לתור – חריגה באחסון');
          driveFull = true;
          break;
        }
        writeLog(subData.title, ep.title, 'שגיאה', msg);
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 }, false);
      }
    }
    if (stopRequested) break;
    checkpointProgress({ podcastIndex: pi + 1, episodeIndex: 0 }, false);
  }

  if (stopRequested) {
    if (getDownloadQueueLength() > 0) {
      scheduleDownloadWorkerAfterMs(60 * 1000);
    }
    debugStep('podcastManager: exit (stopRequested / resume scheduled)', null, runT0);
    return;
  }

  // 3. Save updated metadata and downloaded URL set
  debugStep('podcastManager: syncActiveSubscriptionsMetadata', null, runT0);
  syncActiveSubscriptionsMetadata(subs);
  saveDownloadedSet(downloadedSet);
  debugStep('podcastManager: final saveDownloadedSet', 'size=' + downloadedSet.size, runT0);

  // 4. Run completed – clear resume state and update last successful auto-run timestamp
  props.deleteProperty(PROP_RESUME);
  deleteOneTimeTrigger();
  if (getDownloadQueueLength() > 0) {
    scheduleDownloadWorkerAfterMs(60 * 1000);
    debugStep('podcastManager: scheduled downloadWorker', 'queue=' + getDownloadQueueLength(), runT0);
  }
  if (!driveFull) {
    props.setProperty(PROP_LAST_RUN, String(Date.now()));
  }
  debugStep('podcastManager: completed OK', null, runT0);
}

/**
 * Purpose: Drain one queued episode download per execution to isolate parser memory from downloader
 * memory and avoid V8 OOM spikes in a single run.
 * Operation: Reads one queue item, downloads it with existing engine (supports chunk resume),
 * updates log/download set, and schedules itself again while items remain.
 */
function downloadWorker() {
  const runT0 = Date.now();
  const startTime = runT0;
  const downloadedSet = getDownloadedSet();
  const shouldStop = () => Date.now() - startTime >= SOFT_STOP_MS;
  const job = peekDownloadQueueHead();
  deleteDownloadWorkerTrigger();

  if (!job || !job.episodeUrl) {
    debugStep('downloadWorker: queue empty', null, runT0);
    return;
  }

  const pubDate = job.pubDate ? new Date(job.pubDate) : new Date();
  const safeDate = isNaN(pubDate.getTime()) ? new Date() : pubDate;
  const podcastTitle = job.podcastTitle || 'כללי';

  if (isDownloaded(job.episodeUrl, downloadedSet)) {
    debugStep('downloadWorker: skip downloaded', debugSnippet(job.episodeUrl, 100), runT0);
    shiftDownloadQueue();
    saveDownloadedSet(downloadedSet);
    if (getDownloadQueueLength() > 0) scheduleDownloadWorkerAfterMs(60 * 1000);
    return;
  }

  try {
    const folder = getPodcastFolder(podcastTitle);
    const results = downloadEpisodeToFolder(
      job.episodeUrl,
      job.episodeTitle || 'פרק',
      safeDate,
      folder,
      job.description || '',
      {
        shouldStop,
        runT0,
        resumeOffset: job.resumeOffset != null ? job.resumeOffset : null,
        resumeSessionUrl: job.resumeSessionUrl != null ? job.resumeSessionUrl : null
      }
    );
    markDownloaded(job.episodeUrl, downloadedSet);
    saveDownloadedSet(downloadedSet);
    const link = results.map(r => r.driveUrl).join('\n');
    // Respect the manualDownload flag set by downloadEpisode (sidebar) to log correctly
    const logStatus = job.manualDownload ? 'הורד ידנית' : 'הורד אוטומטית';
    writeLog(podcastTitle, job.episodeTitle || 'פרק', logStatus, '', link);
    shiftDownloadQueue();
    debugStep('downloadWorker: download OK', 'files=' + results.length, runT0);
  } catch (e) {
    if (e && e.code === 'TIME_BUDGET_EXCEEDED') {
      // Persist both the byte offset and the Drive session URL so the next worker
      // run can resume the upload from where it left off without creating a duplicate file.
      job.resumeOffset = e.resumeOffset;
      job.resumeSessionUrl = e.resumeSessionUrl || null;
      updateDownloadQueueHead(job);
      debugStep('downloadWorker: soft-stop resume saved', debugSnippet(JSON.stringify(job), 200), runT0);
    } else {
      const msg = e && e.message ? e.message : String(e);
      const note = (msg.includes('Range requests') || msg.includes('מגבלת UrlFetch'))
        ? 'לא ניתן להוריד – הקובץ גדול מדי והשרת אינו תומך בחלוקה לחלקים (Range)'
        : msg;
      writeLog(podcastTitle, job.episodeTitle || 'פרק', 'שגיאה', note);
      shiftDownloadQueue();
      debugStep('downloadWorker: failed and removed from queue', debugSnippet(note, 180), runT0);
    }
  }

  if (getDownloadQueueLength() > 0) {
    scheduleDownloadWorkerAfterMs(60 * 1000);
    debugStep('downloadWorker: rescheduled', 'queue=' + getDownloadQueueLength(), runT0);
  } else {
    deleteDownloadWorkerTrigger();
    debugStep('downloadWorker: done (queue empty)', null, runT0);
  }
}

function getLastAutoRunLabel() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_LAST_RUN);
  if (!raw) return 'הורדה אוטומטית אחרונה: טרם בוצעה';
  const ts = parseInt(raw, 10);
  if (isNaN(ts)) return 'הורדה אוטומטית אחרונה: טרם בוצעה';
  const tz = Session.getScriptTimeZone() || 'Asia/Jerusalem';
  const text = Utilities.formatDate(new Date(ts), tz, 'dd/MM/yyyy HH:mm');
  return `הורדה אוטומטית אחרונה: ${text}`;
}

/**
 * Purpose: One-time OAuth / permission confirmation step for the podcast manager script.
 *   Running this triggers Apps Script authorization; after success, the user can use the menu.
 * Operation: Shows a Hebrew alert confirming that permissions were granted and directing the user
 *   to the spreadsheet menu (🎙 הסכתים). Pair with `createStartSheet` and a button that runs this.
 */
function authorizeAndInit() {
  SpreadsheetApp.getUi().alert('✓ ההרשאות אושרו בהצלחה! כעת השתמש בתפריט 🎙 הסכתים למעלה.');
}

/**
 * Purpose: Creates a welcome / onboarding sheet named "התחלה" so new users see Hebrew instructions
 *   before using the podcast manager (including how to authorize the script once).
 * Operation: Inserts the sheet at index 0 if missing, sets column/row sizes, writes title and
 *   step-by-step text in column B, styles cells, and sets a green tab color to match the flow.
 */
function createStartSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('התחלה')) return;
  const sheet = ss.insertSheet('התחלה', 0);

  sheet.setColumnWidth(1, 30);
  sheet.setColumnWidth(2, 400);
  sheet.setRowHeight(1, 30);
  sheet.setRowHeight(2, 60);
  sheet.setRowHeight(3, 200);
  sheet.setRowHeight(4, 60);

  const titleRange = sheet.getRange('B2');
  titleRange.setValue('🎙 ברוך הבא למנהל ההסכתים');
  titleRange.setFontSize(18).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');

  const instrRange = sheet.getRange('B3');
  instrRange.setValue(
    'לפני השימוש יש לאשר הרשאות גישה:\n\n' +
    '① לחץ על הכפתור הירוק למטה\n' +
    '② בחלון שייפתח — לחץ "Continue" ואשר את כל ההרשאות\n' +
    '③ חזור לכאן — התפריט 🎙 הסכתים יהיה זמין'
  );
  instrRange.setFontSize(13).setWrap(true).setVerticalAlignment('middle');

  const noteRange = sheet.getRange('B4');
  noteRange.setValue('פעולה זו נדרשת פעם אחת בלבד.');
  noteRange.setFontSize(11).setFontColor('#888888').setHorizontalAlignment('center');

  sheet.setTabColor('#34A853');
}
