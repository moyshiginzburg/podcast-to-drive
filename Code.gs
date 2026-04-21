/**
 * Podcast to Drive
 * Author: Moyshi
 * GitHub: https://github.com/moyshiginzburg/podcast-to-drive
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
 * Max per Range response: stay under Apps Script UrlFetch’s ~50MB response cap.
 * Peak RAM is mitigated by in-place Xing fix + dropping refs after each part (not by shrinking this).
 */
const CHUNK_SIZE = 45 * 1024 * 1024; // 45 MB
const URL_FETCH_RESPONSE_LIMIT = 50 * 1024 * 1024; // Apps Script UrlFetch response cap
const SOFT_STOP_MS = 4 * 60 * 1000;
const RESUME_TRIGGER_DELAY_MS = 30 * 1000;

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

function buildFileName(episodeTitle, pubDate, partNum) {
  const dateStr = formatDateYYMMDD(pubDate || new Date());
  const safeTitle = sanitizeFileName(episodeTitle) || 'פרק';
  if (partNum != null) {
    const part = String(partNum).padStart(3, '0');
    return `${dateStr} ${safeTitle} (חלק ${part}).mp3`;
  }
  return `${dateStr} ${safeTitle}.mp3`;
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
 * Main entry point: downloads one episode to Google Drive.
 * Returns array of { fileId, fileName, driveUrl } (one item for direct, multiple for chunked).
 * Throws on unrecoverable error.
 */
function downloadEpisodeToFolder(episodeUrl, episodeTitle, pubDate, folder, description, options) {
  const runT0 = options && options.runT0;
  debugStep(
    'downloadEpisodeToFolder: start',
    debugSnippet(episodeTitle, 80) + ' | ' + debugSnippet(episodeUrl, 120),
    runT0
  );
  const contentLength = fetchContentLength(episodeUrl, runT0);

  if (contentLength !== null && contentLength <= CHUNK_SIZE) {
    const fileName = buildFileName(episodeTitle, pubDate);
    debugStep('downloadEpisodeToFolder: path=direct', 'file=' + debugSnippet(fileName, 100), runT0);
    try {
      return [downloadDirect(episodeUrl, fileName, folder, description, runT0)];
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      if (msg.includes('מגבלת UrlFetch')) {
        debugStep('downloadEpisodeToFolder: direct fallback to chunked', null, runT0);
        return downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, null, options);
      }
      throw e;
    }
  }

  if (contentLength !== null && contentLength > CHUNK_SIZE) {
    debugStep('downloadEpisodeToFolder: path=chunked', 'totalSize=' + contentLength, runT0);
    return downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, contentLength, options);
  }

  // Unknown size: prefer chunked to avoid UrlFetch's 50MB direct-response limit.
  debugStep('downloadEpisodeToFolder: path=chunked (unknown size)', null, runT0);
  return downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, null, options);
}

function getHeaderCaseInsensitive(headers, key) {
  const wanted = String(key || '').toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === wanted) return headers[keys[i]];
  }
  return null;
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

function ensureFullResponseBytes(resp, context, runT0) {
  const headers = resp.getHeaders() || {};
  const bytes = resp.getContent();
  debugStep('ensureFullResponseBytes: ' + context, 'bytes=' + bytes.length, runT0);
  const actualSize = bytes.length;
  const declaredLength = parseContentLength(headers);

  if (declaredLength !== null && declaredLength > actualSize) {
    throw new Error(`${context}: השרת דיווח על ${declaredLength} בתים, אבל התקבלו רק ${actualSize} בתים`);
  }
  if (actualSize >= URL_FETCH_RESPONSE_LIMIT) {
    throw new Error(`${context}: התגובה הגיעה למגבלת UrlFetch (50MB)`);
  }
  return bytes;
}

function byteAt(bytes, i) {
  const v = bytes[i];
  return v < 0 ? v + 256 : v;
}

function hasAsciiAt(bytes, offset, text) {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (byteAt(bytes, offset + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}

function parseSynchsafeInt(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const b0 = byteAt(bytes, offset);
  const b1 = byteAt(bytes, offset + 1);
  const b2 = byteAt(bytes, offset + 2);
  const b3 = byteAt(bytes, offset + 3);
  if ((b0 | b1 | b2 | b3) & 0x80) return null;
  return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
}

/**
 * MP3 first chunks may carry Xing/Info metadata with total file length.
 * In split downloads this can make part 001 look as long as the full episode.
 * Clearing the marker makes players derive duration from the actual part bytes.
 */
function normalizeFirstChunkDurationMetadata(bytes) {
  if (!bytes || bytes.length < 8) return bytes;

  let frameStart = 0;
  // Skip optional ID3v2 tag
  if (hasAsciiAt(bytes, 0, 'ID3')) {
    const tagSize = parseSynchsafeInt(bytes, 6);
    if (tagSize === null) return bytes;
    const flags = byteAt(bytes, 5);
    const hasFooter = (flags & 0x10) !== 0;
    frameStart = 10 + tagSize + (hasFooter ? 10 : 0);
  }

  if (frameStart + 4 >= bytes.length) return bytes;
  const b1 = byteAt(bytes, frameStart);
  const b2 = byteAt(bytes, frameStart + 1);
  const b4 = byteAt(bytes, frameStart + 3);
  if (b1 !== 0xFF || (b2 & 0xE0) !== 0xE0) return bytes;

  const versionBits = (b2 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b2 >> 1) & 0x03;   // 1=Layer III
  if (versionBits === 1 || layerBits !== 1) return bytes;

  const hasCrc = (b2 & 0x01) === 0;
  const channelMode = (b4 >> 6) & 0x03; // 3=mono
  const sideInfoSize = versionBits === 3
    ? (channelMode === 3 ? 17 : 32)
    : (channelMode === 3 ? 9 : 17);

  const xingOffset = frameStart + 4 + (hasCrc ? 2 : 0) + sideInfoSize;
  const hasXing = hasAsciiAt(bytes, xingOffset, 'Xing') || hasAsciiAt(bytes, xingOffset, 'Info');
  if (!hasXing) return bytes;

  // Mutate in place — avoids a full-array copy (~CHUNK_SIZE) that doubled RAM on part 001.
  bytes[xingOffset] = 0;
  bytes[xingOffset + 1] = 0;
  bytes[xingOffset + 2] = 0;
  bytes[xingOffset + 3] = 0;
  return bytes;
}

function fetchContentLength(url, runT0) {
  // UrlFetchApp supports only get/post/put/delete/patch — not "head" (invalid method in Apps Script).
  debugStep('fetchContentLength: Range probe (bytes=0-0)', debugSnippet(url, 120), runT0);
  try {
    const probeResp = UrlFetchApp.fetch(url, {
      headers: { Range: 'bytes=0-0' },
      followRedirects: true,
      muteHttpExceptions: true
    });
    debugStep('fetchContentLength: probe response', 'HTTP ' + probeResp.getResponseCode(), runT0);
    const headers = probeResp.getHeaders() || {};
    const fromRange = parseTotalSizeFromContentRange(headers);
    if (fromRange !== null) {
      debugStep('fetchContentLength: from Content-Range', 'length=' + fromRange, runT0);
      return fromRange;
    }
    const fromCl = parseContentLength(headers);
    if (fromCl !== null) debugStep('fetchContentLength: from Content-Length', 'length=' + fromCl, runT0);
    return fromCl;
  } catch (e) {
    debugStep('fetchContentLength: probe failed', e.message || String(e), runT0);
    return null;
  }
}

function downloadDirect(url, fileName, folder, description, runT0) {
  debugStep('downloadDirect: UrlFetch start', debugSnippet(url, 120), runT0);
  const resp = UrlFetchApp.fetch(url, { followRedirects: true, muteHttpExceptions: true });
  debugStep('downloadDirect: UrlFetch done', 'HTTP ' + resp.getResponseCode(), runT0);
  if (resp.getResponseCode() >= 400) {
    throw new Error(`HTTP ${resp.getResponseCode()} בעת הורדת הפרק`);
  }
  const bytes = ensureFullResponseBytes(resp, 'הורדה ישירה נכשלה', runT0);
  const blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
  debugStep('downloadDirect: createFile start', debugSnippet(fileName, 100), runT0);
  const file = folder.createFile(blob);
  debugStep('downloadDirect: createFile done', 'id=' + file.getId(), runT0);
  if (description) file.setDescription(description);
  return {
    fileId: file.getId(),
    fileName,
    driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
  };
}

function buildTimeBudgetExceededError(offset, part) {
  const err = new Error('TIME_BUDGET_EXCEEDED');
  err.code = 'TIME_BUDGET_EXCEEDED';
  err.resumeOffset = offset;
  err.resumePart = part;
  return err;
}

function downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, totalSize, options) {
  const runT0 = options && options.runT0;
  const results = [];
  let offset = (options && typeof options.resumeOffset === 'number' && options.resumeOffset >= 0)
    ? options.resumeOffset
    : 0;
  let part = (options && typeof options.resumePart === 'number' && options.resumePart > 0)
    ? options.resumePart
    : 1;

  while (true) {
    if (options && typeof options.shouldStop === 'function' && options.shouldStop()) {
      debugStep('downloadChunked: shouldStop before part', 'part=' + part + ' offset=' + offset, runT0);
      throw buildTimeBudgetExceededError(offset, part);
    }

    const rangeEnd = totalSize
      ? Math.min(offset + CHUNK_SIZE - 1, totalSize - 1)
      : offset + CHUNK_SIZE - 1;

    debugStep(
      'downloadChunked: UrlFetch Range',
      `part=${part} bytes=${offset}-${rangeEnd}` + (totalSize != null ? ` of ${totalSize}` : ''),
      runT0
    );
    let resp;
    try {
      resp = UrlFetchApp.fetch(episodeUrl, {
        headers: { Range: `bytes=${offset}-${rangeEnd}` },
        followRedirects: true,
        muteHttpExceptions: true
      });
    } catch (e) {
      throw new Error(`שגיאת רשת בחלק ${part}: ${e.message}`);
    }

    const code = resp.getResponseCode();
    debugStep('downloadChunked: response', 'part=' + part + ' HTTP ' + code, runT0);

    // Server returned 200 instead of 206 → doesn't support Range
    if (code === 200) {
      if (part === 1) {
        // We got the whole file in one shot – save it
        const fileName = buildFileName(episodeTitle, pubDate);
        const bytes = ensureFullResponseBytes(resp, 'השרת לא תמך ב-Range והחזיר תגובה חלקית', runT0);
        const blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
        debugStep('downloadChunked: createFile (200 full)', debugSnippet(fileName, 100), runT0);
        const file = folder.createFile(blob);
        if (description) file.setDescription(description);
        return [{
          fileId: file.getId(),
          fileName,
          driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
        }];
      }
      // We already downloaded some chunks but now get 200 – abort
      throw new Error('השרת אינו תומך ב-Range requests – לא ניתן להמשיך הורדה בחלקים');
    }

    if (code !== 206) {
      throw new Error(`HTTP ${code} בחלק ${part}`);
    }

    const fileName = buildFileName(episodeTitle, pubDate, part);
    let blob;
    let partLen;

    if (part === 1) {
      debugStep('downloadChunked: getContent start', 'part=' + part, runT0);
      let bytes = resp.getContent();
      debugStep('downloadChunked: getContent done', 'part=' + part + ' len=' + bytes.length, runT0);
      debugStep('downloadChunked: normalizeFirstChunkDurationMetadata', 'part=1', runT0);
      bytes = normalizeFirstChunkDurationMetadata(bytes);
      debugStep('downloadChunked: normalizeFirstChunkDurationMetadata done', 'len=' + bytes.length, runT0);
      partLen = bytes.length;
      debugStep('downloadChunked: newBlob start', 'part=' + part + ' len=' + partLen, runT0);
      blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
      bytes = null;
    } else {
      blob = resp.getBlob().setName(fileName).setContentType('audio/mpeg');
      const headers = resp.getHeaders() || {};
      const declaredLen = parseContentLength(headers);
      partLen = declaredLen !== null ? declaredLen : (rangeEnd - offset + 1);
      debugStep('downloadChunked: getBlob done', 'part=' + part + ' len=' + partLen, runT0);
    }
    resp = null;
    debugStep('downloadChunked: createFile start', 'part=' + part + ' ' + debugSnippet(fileName, 100), runT0);
    const file = folder.createFile(blob);
    debugStep('downloadChunked: createFile done', 'part=' + part + ' id=' + file.getId(), runT0);
    if (description) file.setDescription(`${description ? description + ' ' : ''}(חלק ${part})`);

    results.push({
      fileId: file.getId(),
      fileName,
      driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
    });

    offset += partLen;

    // End conditions
    if (totalSize && offset >= totalSize) break;
    if (!totalSize && partLen < CHUNK_SIZE) break; // server returned less → EOF

    part++;
  }

  debugStep('downloadChunked: finished', 'parts=' + results.length, runT0);
  return results;
}

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

/** Returns episode list for a given RSS URL */
function fetchEpisodeList(rssUrl) {
  try {
    const data = parseRSS(rssUrl);
    return { success: true, title: data.title, imageUrl: data.imageUrl, episodes: data.episodes };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Manually downloads one episode from sidebar */
function downloadEpisode(episodeData) {
  // episodeData: { url, title, date, description, podcastTitle }
  let runT0;
  try {
    if (!episodeData || !episodeData.url) {
      return { success: false, error: 'נתוני הפרק חסרים' };
    }

    runT0 = Date.now();
    debugStep('downloadEpisode (sidebar): start', debugSnippet(episodeData.url, 150), runT0);
    const pubDate = episodeData.date ? new Date(episodeData.date) : new Date();
    syncDownloadedFlagWithDrive(
      episodeData.url,
      episodeData.podcastTitle || 'כללי',
      episodeData.title || 'פרק',
      pubDate,
      undefined,
      runT0
    );

    if (isDownloaded(episodeData.url)) {
      debugStep('downloadEpisode (sidebar): already in downloaded set', null, runT0);
      return { success: false, alreadyDownloaded: true, error: 'הפרק כבר הורד בעבר' };
    }

    const folder = getPodcastFolder(episodeData.podcastTitle || 'כללי');
    const description = episodeData.description || '';

    const results = downloadEpisodeToFolder(
      episodeData.url,
      episodeData.title || 'פרק',
      pubDate,
      folder,
      description,
      { runT0 }
    );

    markDownloaded(episodeData.url);
    const link = results.map(r => r.driveUrl).join('\n');
    writeLog(episodeData.podcastTitle || '', episodeData.title || '', 'הורד ידנית', '', link);
    debugStep('downloadEpisode (sidebar): success', 'files=' + results.length, runT0);

    return { success: true, files: results };
  } catch (e) {
    debugStep('downloadEpisode (sidebar): catch', (e.message || String(e)).slice(0, 200), runT0);
    const isDriveFull = (e.message || '').toLowerCase().includes('storage');
    const isRangeUnsupported = (e.message || '').includes('Range requests');
    const isUrlFetchLimit = (e.message || '').includes('מגבלת UrlFetch');

    let userMessage = e.message;
    if (isDriveFull) userMessage = 'Drive מלא – הורדה נכשלה';
    if (isRangeUnsupported || isUrlFetchLimit) {
      userMessage = 'לא ניתן להוריד – הקובץ גדול מדי והשרת אינו תומך בחלוקה לחלקים (Range)';
    }

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
      scheduleDownloadWorkerAfterMs(1);
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
      scheduleDownloadWorkerAfterMs(1);
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
    scheduleDownloadWorkerAfterMs(1);
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
    if (getDownloadQueueLength() > 0) scheduleDownloadWorkerAfterMs(1);
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
        resumePart: job.resumePart != null ? job.resumePart : null
      }
    );
    markDownloaded(job.episodeUrl, downloadedSet);
    saveDownloadedSet(downloadedSet);
    const link = results.map(r => r.driveUrl).join('\n');
    writeLog(podcastTitle, job.episodeTitle || 'פרק', 'הורד אוטומטית', '', link);
    shiftDownloadQueue();
    debugStep('downloadWorker: download OK', 'files=' + results.length, runT0);
  } catch (e) {
    if (e && e.code === 'TIME_BUDGET_EXCEEDED') {
      job.resumeOffset = e.resumeOffset;
      job.resumePart = e.resumePart;
      updateDownloadQueueHead(job);
      debugStep('downloadWorker: soft-stop resume saved', debugSnippet(JSON.stringify(job), 180), runT0);
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
    scheduleDownloadWorkerAfterMs(1);
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
