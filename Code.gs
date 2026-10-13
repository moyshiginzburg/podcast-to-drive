/**
 * Podcast to Drive
 * Author: Moyshi
 * GitHub: https://github.com/moyshiginzburg/podcast-to-drive
 * Version: 2026-10-13
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
const FAILED_EPISODES_SHEET_NAME = 'פרקים שנכשלו';
const FAILED_EPISODES_HEADERS = ['כתובת', 'הסכת', 'פרק', 'מספר כישלונות', 'שגיאה אחרונה', 'עדכון אחרון'];
/**
 * How many times in a row the worker re-attempts one queued episode after a temporary problem
 * (network error, server 5xx / 429 / 408) before giving up on it for the current round.
 * Attempts are one worker run apart, i.e. about a minute.
 */
const MAX_TRANSIENT_RETRIES = 5;
/**
 * How many failed download rounds an episode may accumulate before the automatic scan stops
 * re-queuing it. A scan runs every 6 hours, so 12 rounds is about three days – long enough to
 * outlast a server outage, short enough that a permanently dead episode does not fill the Log
 * forever. A manual download from the sidebar resets the count.
 */
const MAX_EPISODE_FAILURES = 12;
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
const SOFT_STOP_MS = 4 * 60 * 1000;
const RESUME_TRIGGER_DELAY_MS = 60 * 1000; // 1 minute (to prevent Google scheduler throttling)
/** Extension given to an episode file when its real type cannot be determined. */
const DEFAULT_FILE_EXTENSION = 'mp3';

// Longest episode description stored on the Drive file: the limit Drive itself shows for a file
// description (the counter in the file details panel reads "n/25,000").
const MAX_DESCRIPTION_LENGTH = 25000;
// A queued job is one JSON string in one sheet cell, and Google Sheets holds at most 50,000
// characters in a cell.
const QUEUE_CELL_MAX_CHARS = 50000;
// Longest job written when an episode is queued. The rest of the cell stays free for what the
// worker adds to the job later (upload session address, resume offset, retry counter).
const QUEUE_JOB_MAX_CHARS = QUEUE_CELL_MAX_CHARS - 5000;
// Length a description is cut to if Drive refuses the full one (the length used before the
// full description was stored).
const FALLBACK_DESCRIPTION_LENGTH = 800;

/**
 * Purpose: The file types the downloader recognizes by name, and the MIME type each one is
 *   uploaded to Drive with. An RSS enclosure is not necessarily audio: feeds also publish video,
 *   documents, images and archives, and every one of them must keep its real extension.
 * Operation: `detectFileExtension` trusts a URL extension that appears here, and
 *   `downloadResumable` uses the value as the Drive MIME type. This table is NOT a whitelist:
 *   a type missing from it is still saved correctly, with the extension taken from the server's
 *   Content-Type or from the URL (see `detectFileExtension`).
 */
const MIME_TYPE_BY_EXTENSION = {
  // Audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff', aif: 'audio/aiff', weba: 'audio/webm', amr: 'audio/amr', mid: 'audio/midi',
  // Video
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg',
  mpeg: 'video/mpeg', ogv: 'video/ogg', '3gp': 'video/3gpp', flv: 'video/x-flv', ts: 'video/mp2t',
  // Documents
  pdf: 'application/pdf', epub: 'application/epub+zip', txt: 'text/plain', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', srt: 'application/x-subrip', vtt: 'text/vtt',
  // Images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  // Archives
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  gz: 'application/gzip', tar: 'application/x-tar'
};
/**
 * Purpose: Translate a server's Content-Type into a file extension when the URL has no usable one.
 * Operation: Exact (lowercase, parameters stripped) MIME type -> extension. Holds the canonical
 *   types of `MIME_TYPE_BY_EXTENSION` plus the common non-standard aliases servers send.
 */
const EXTENSION_BY_MIME_TYPE = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpeg3': 'mp3', 'audio/x-mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4b': 'm4b',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/aacp': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/x-ms-wma': 'wma',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/webm': 'weba', 'audio/amr': 'amr',
  'audio/midi': 'mid',
  'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/x-ms-wmv': 'wmv',
  'video/mpeg': 'mpg', 'video/ogg': 'ogv', 'video/3gpp': '3gp', 'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  // 'text/plain' is deliberately absent: misconfigured servers send it for audio files, and
  // those must keep falling through to the URL extension or the default.
  'application/pdf': 'pdf', 'application/epub+zip': 'epub',
  'application/rtf': 'rtf', 'text/rtf': 'rtf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv', 'application/x-subrip': 'srt', 'text/vtt': 'vtt',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
  'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-tar': 'tar'
};
/**
 * URL "extensions" that name the server-side script producing the download rather than the type
 * of the file itself (e.g. `download.php?id=7`). Never used as a file extension.
 */
const NON_FILE_URL_EXTENSIONS = [
  'php', 'php5', 'asp', 'aspx', 'ashx', 'jsp', 'jspx', 'cgi', 'pl', 'py', 'rb', 'do', 'action',
  'cfm', 'html', 'htm', 'xhtml', 'shtml', 'js', 'json', 'xml', 'rss', 'atom', 'com', 'net', 'org'
];

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
  let isAutoOn = false;
  let isAutoOff = false;
  
  try {
    const props = PropertiesService.getScriptProperties();
    let flag = props.getProperty('autoDownloadEnabled');
    
    if (!flag) {
      // First time migrating to property flag (or user deleted property).
      // Attempt to read triggers if we happen to have permissions.
      try {
        const triggers = getPeriodicTriggers();
        flag = triggers.length > 0 ? 'true' : 'false';
        props.setProperty('autoDownloadEnabled', flag);
      } catch (e) {
        // If no permissions yet (e.g. brand new user), assume it's ON visually
        // because authorizeAndInit() will auto-install it anyway.
        flag = 'true';
      }
    }

    if (flag === 'true') {
      isAutoOn = true;
    } else if (flag === 'false') {
      isAutoOff = true;
    }
  } catch (e) {
    // Ignore errors before initial authorization
  }

  const menu = SpreadsheetApp.getUi().createMenu('🎙 הסכתים')
    .addItem('פתח מנהל הסכתים', 'showSidebar')
    .addSeparator()
    .addItem('הפעל הורדה עכשיו', 'podcastManager');

  if (isAutoOn) {
    menu.addItem('✓ הגדר הורדה אוטומטית (כל 6 שעות)', 'menuEnableAuto');
    menu.addItem('כבה הורדה אוטומטית', 'menuDisableAuto');
  } else if (isAutoOff) {
    menu.addItem('הגדר הורדה אוטומטית (כל 6 שעות)', 'menuEnableAuto');
    menu.addItem('✓ כבה הורדה אוטומטית', 'menuDisableAuto');
  } else {
    menu.addItem('הגדר הורדה אוטומטית (כל 6 שעות)', 'menuEnableAuto');
    menu.addItem('כבה הורדה אוטומטית', 'menuDisableAuto');
  }

  menu.addToUi();
}

function showSidebar() {
  // Sync the autoDownloadEnabled property when sidebar is opened (since we have full auth here)
  try {
    const props = PropertiesService.getScriptProperties();
    const triggers = getPeriodicTriggers();
    props.setProperty('autoDownloadEnabled', triggers.length > 0 ? 'true' : 'false');
  } catch (e) {}

  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('🎙 מנהל הסכתים')
    .setWidth(720)
    .setHeight(580);
  SpreadsheetApp.getUi().showModalDialog(html, '🎙 מנהל הסכתים');
}

// ============================================================
// TRIGGER MANAGEMENT
// ============================================================

function menuEnableAuto() {
  installTrigger();
  SpreadsheetApp.getUi().alert('ההורדה האוטומטית הופעלה בהצלחה (ותרוץ כל 6 שעות).\n* שימו לב: סימון ה-✓ בתפריט יתעדכן רק לאחר ריענון של העמוד.');
}

function menuDisableAuto() {
  uninstallTrigger();
  SpreadsheetApp.getUi().alert('ההורדה האוטומטית כובתה.\n* שימו לב: סימון ה-✓ בתפריט יוסר רק לאחר ריענון של העמוד.');
}

function installTrigger() {
  uninstallTrigger();
  ScriptApp.newTrigger('podcastManager').timeBased().everyHours(6).create();
  PropertiesService.getScriptProperties().setProperty('autoDownloadEnabled', 'true');
}

function uninstallTrigger() {
  getPeriodicTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().setProperty('autoDownloadEnabled', 'false');
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

/**
 * Purpose: Schedule (or re-schedule) the downloadWorker to run after `delayMs` milliseconds.
 * Operation: Always deletes any previously stored worker trigger first, then creates a fresh
 *   one-shot time-based trigger. This "delete-and-recreate" approach prevents a deadlock where
 *   a stale trigger (e.g. one that failed with a Google INTERNAL error before the worker could
 *   delete it) remains registered but disabled, causing all future scheduling attempts to
 *   no-op because the trigger technically "exists" in getProjectTriggers().
 *   Safe to call repeatedly — the worker is idempotent (checks the queue on entry).
 */
function scheduleDownloadWorkerAfterMs(delayMs) {
  deleteDownloadWorkerTrigger();
  const trig = ScriptApp.newTrigger('downloadWorker').timeBased().after(delayMs).create();
  PropertiesService.getScriptProperties().setProperty(PROP_DOWNLOAD_WORKER_TRIG, trig.getUniqueId());
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

function getSetting(key, defaultValue) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('הגדרות');
  if (!sheet) return defaultValue;
  
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      return data[i][1] || defaultValue;
    }
  }
  return defaultValue;
}

function saveSetting(key, value) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('הגדרות');
  if (!sheet) {
    sheet = ss.insertSheet('הגדרות');
    sheet.appendRow(['הגדרה', 'ערך']);
    sheet.setFrozenRows(1);
  } else if (sheet.isSheetHidden()) {
    sheet.showSheet();
  }
  
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

/**
 * Purpose: Give the management dialog everything it needs to draw the podcast list and to word
 *   its "podcast added" message truthfully.
 * Operation: Reads the saved sort preference and the active rows of the subscriptions sheet.
 *   Also reports whether automatic downloading is on, taken from the `autoDownloadEnabled`
 *   script property that `showSidebar` refreshes from the real triggers every time the dialog
 *   opens – so this costs no trigger lookup and no extra call from the dialog. A missing
 *   property counts as "on", the same assumption `onOpen` makes for a brand-new user.
 * @returns {{ list: Array<Object>, sortMode: string, autoEnabled: boolean }}
 */
function getSubscriptionsList() {
  const sortMode = getSetting('podcastSortMode', 'default');
  const autoEnabled =
    PropertiesService.getScriptProperties().getProperty('autoDownloadEnabled') !== 'false';

  const list = getSubscriptionRows()
    .filter(row => row.status === STATUS_ACTIVE)
    .map(row => ({
      url: row.url,
      title: row.title || row.url,
      imageUrl: row.imageUrl || '',
      subscribeDate: row.subscribeDate || 0
    }));

  return { list, sortMode, autoEnabled };
}

function savePodcastSortMode(mode) {
  saveSetting('podcastSortMode', String(mode));
}

/** Called from sidebar – add a new subscription */
function addSubscription(rssUrl, title, imageUrl) {
  const url = String(rssUrl || '').trim();
  if (!url) return { success: false, message: 'כתובת RSS חסרה' };

  const sheet = getSubscriptionsSheet();
  const rows = getSubscriptionRows();
  const existing = rows.find(row => row.url === url);

  if (existing && existing.status === STATUS_ACTIVE) {
    return { success: false, message: 'ההסכת הזה כבר ברשימה שלכם' };
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

  scheduleAutoOpmlBackup();
  return { success: true };
}

/**
 * Purpose: Adds multiple podcast subscriptions efficiently to the database sheet in a single bulk operation.
 * Operation: Receives an array of podcast objects, filters out existing active ones, updates
 *   cancelled ones in-place if possible, and appends all new ones in one Google Sheets API call
 *   (`setValues`). Schedules the OPML backup only once at the very end to avoid trigger quotas.
 */
function addMultipleSubscriptions(podcasts) {
  const sheet = getSubscriptionsSheet();
  const rows = getSubscriptionRows();
  let addedCount = 0;
  let skippedCount = 0;
  const newRows = [];
  const now = new Date();

  podcasts.forEach(p => {
    const url = String(p.url || '').trim();
    if (!url) return;

    const existing = rows.find(row => row.url === url);
    if (existing && existing.status === STATUS_ACTIVE) {
      skippedCount++;
      return;
    }

    const values = [
      url,
      p.title || url,
      p.imageUrl || '',
      now,
      STATUS_ACTIVE
    ];

    if (existing) {
      sheet.getRange(existing.rowIndex, 1, 1, 5).setValues([values]);
      addedCount++;
    } else {
      newRows.push(values);
      addedCount++;
    }
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
  }

  if (addedCount > 0) {
    scheduleAutoOpmlBackup();
  }

  return { added: addedCount, skipped: skippedCount };
}

/**
 * Purpose: Extracts the podcast title and image URL from the raw XML content of an RSS feed.
 * Operation: Uses Regex to find the <channel> block, then searches for <title> and <itunes:image> or <image><url> tags.
 *   Returns an object with title and imageUrl strings (empty strings if not found).
 */
function parseXmlForMetadata(xmlText) {
  let title = '';
  let imageUrl = '';
  if (!xmlText) return { title, imageUrl };
  
  const text = String(xmlText).substring(0, 100000);
  const channelMatch = text.match(/<channel[\s\S]*?(?=<item>|<\/channel>)/i);
  if (channelMatch) {
    const channelText = channelMatch[0];
    const titleMatch = channelText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/is, "$1").trim();
    }
    const itunesImgMatch = channelText.match(/<itunes:image[^>]+href=["']([^"']+)["']/i);
    if (itunesImgMatch) {
      imageUrl = itunesImgMatch[1];
    } else {
      const imgMatch = channelText.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/i);
      if (imgMatch) {
        imageUrl = imgMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/is, "$1").trim();
      }
    }
  }
  return { title, imageUrl };
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
    scheduleAutoOpmlBackup();
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

/**
 * Purpose: Record that an episode was downloaded, without disturbing what other executions wrote
 *   to the downloads sheet in the meantime.
 * Operation: Appends the URL as one new row. It deliberately does NOT rewrite the whole list:
 *   a scan (`podcastManager`) and the worker can run at the same time, and a "read everything,
 *   then write everything back" update lets whichever finishes last erase the other's rows –
 *   which made finished episodes download a second time. The optional in-memory set is updated
 *   as well so the caller's own view stays current.
 */
function markDownloaded(url, set) {
  if (set) set.add(url);
  getDownloadsSheet().appendRow([url]);
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
  if (sheet.isSheetHidden()) {
    sheet.showSheet();
  }
  return sheet;
}

function enqueueDownloadJob(payload) {
  const sheet = ensureDownloadQueueSheet();
  sheet.appendRow([serializeJobForQueue(payload)]);
}

/**
 * Purpose: Turn a download job into the JSON string stored in its queue cell, guaranteed to fit
 *   the cell, so a long episode description can never make queuing the episode fail.
 * Operation: Serializes the job. A description of up to MAX_DESCRIPTION_LENGTH characters
 *   normally fits with room to spare, but JSON writes every line break and quotation mark as
 *   two characters, so an unusual text can come out much longer than it is. If the string is
 *   longer than QUEUE_JOB_MAX_CHARS, the description (the only large field) is cut by the excess
 *   and the job is serialized again, until it fits. The caller's object is not modified.
 * @param {Object} payload - The job to queue.
 * @returns {string} - JSON string of at most QUEUE_JOB_MAX_CHARS characters (as long as the
 *   job fits without its description).
 */
function serializeJobForQueue(payload) {
  const job = Object.assign({}, payload || {});
  let json = JSON.stringify(job);
  while (json.length > QUEUE_JOB_MAX_CHARS && job.description) {
    const excess = json.length - QUEUE_JOB_MAX_CHARS;
    job.description = truncateText(job.description, job.description.length - excess);
    json = JSON.stringify(job);
  }
  return json;
}

/**
 * Purpose: Cut a text to a maximum length in a way that still reads as deliberately cut.
 * Operation: Returns the text unchanged when it fits. Otherwise keeps the first `maxLength - 1`
 *   characters, drops a trailing half of a two-unit character (such as an emoji) so no broken
 *   character is left behind, trims trailing spaces and appends "…". A maximum of zero or less
 *   gives an empty string.
 * @param {string} text - Text to cut.
 * @param {number} maxLength - Maximum length of the result, in characters.
 * @returns {string}
 */
function truncateText(text, maxLength) {
  const full = String(text || '');
  if (full.length <= maxLength) return full;
  if (maxLength <= 0) return '';
  let kept = full.slice(0, maxLength - 1);
  const lastCode = kept.charCodeAt(kept.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) kept = kept.slice(0, -1);
  return kept.trim() + '…';
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
  return getQueuedEpisodeUrls().has(episodeUrl);
}

/**
 * Purpose: List every episode currently waiting in the download queue, so callers can avoid
 *   adding the same episode twice.
 * Operation: Reads all rows of the queue sheet once, parses each JSON payload and collects its
 *   `episodeUrl` into a Set. Malformed rows are skipped.
 * @returns {Set<string>} - Episode URLs present in the queue.
 */
function getQueuedEpisodeUrls() {
  const urls = new Set();
  const sheet = ensureDownloadQueueSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return urls;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    try {
      const job = JSON.parse(String(values[i][0] || '').trim());
      if (job && job.episodeUrl) urls.add(job.episodeUrl);
    } catch (_) { /* skip malformed rows */ }
  }
  return urls;
}

// ============================================================
// FAILED EPISODE TRACKING
// ============================================================

/**
 * Purpose: Get the sheet that counts how many times each episode failed to download.
 * Operation: Returns the existing sheet. When it does not exist yet it is created only if
 *   `createIfMissing` is true, so users who never had a failure never see this sheet at all.
 * @param {boolean} createIfMissing - Create the sheet (with headers) when it is absent.
 * @returns {Sheet|null}
 */
function getFailedEpisodesSheet(createIfMissing) {
  const existing = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FAILED_EPISODES_SHEET_NAME);
  if (existing || !createIfMissing) return existing || null;
  return ensureSheetWithHeaders(FAILED_EPISODES_SHEET_NAME, FAILED_EPISODES_HEADERS);
}

/**
 * Purpose: Find the row of one episode in the failed-episodes sheet.
 * Operation: Scans the URL column and returns the 1-based sheet row and the current failure
 *   count, or null when the episode has no record (or the sheet does not exist).
 * @returns {{sheet: Sheet, rowIndex: number, count: number}|null}
 */
function findEpisodeFailureRow(episodeUrl) {
  const sheet = getFailedEpisodesSheet(false);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, FAILED_EPISODES_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === episodeUrl) {
      return { sheet, rowIndex: i + 2, count: parseInt(values[i][3], 10) || 0 };
    }
  }
  return null;
}

/**
 * Purpose: Tell the automatic scan which episodes keep failing, so it can stop re-queuing an
 *   episode that is dead for good (e.g. its file was removed from the podcast server).
 * Operation: Reads the failed-episodes sheet once and returns a Map of episode URL -> number of
 *   failed download rounds. Empty when the sheet does not exist.
 * @returns {Map<string, number>}
 */
function getEpisodeFailureCounts() {
  const counts = new Map();
  const sheet = getFailedEpisodesSheet(false);
  if (!sheet) return counts;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return counts;
  const values = sheet.getRange(2, 1, lastRow - 1, FAILED_EPISODES_HEADERS.length).getValues();
  values.forEach(row => {
    const url = String(row[0] || '').trim();
    if (url) counts.set(url, parseInt(row[3], 10) || 0);
  });
  return counts;
}

/**
 * Purpose: Count one more failed download round for an episode.
 * Operation: Called when the worker gives up on a queued episode and removes it from the queue.
 *   Increments the episode's counter (creating its row on the first failure) and stores the
 *   latest error text and time, which also lets the user see in the sheet what is failing.
 * @returns {number} - The episode's failure count after this failure.
 */
function recordEpisodeFailure(episodeUrl, podcastTitle, episodeTitle, errorMessage) {
  const note = String(errorMessage || '').slice(0, 300);
  const found = findEpisodeFailureRow(episodeUrl);
  if (found) {
    const count = found.count + 1;
    found.sheet.getRange(found.rowIndex, 4, 1, 3).setValues([[count, note, new Date()]]);
    return count;
  }
  getFailedEpisodesSheet(true).appendRow([episodeUrl, podcastTitle || '', episodeTitle || '', 1, note, new Date()]);
  return 1;
}

/**
 * Purpose: Forget an episode's past failures – after it finally downloaded, or when the user asks
 *   for it again by hand (which gives it a fresh set of automatic attempts).
 * Operation: Deletes the episode's row from the failed-episodes sheet, if it has one.
 */
function clearEpisodeFailure(episodeUrl) {
  const found = findEpisodeFailureRow(episodeUrl);
  if (found) found.sheet.deleteRow(found.rowIndex);
}

/**
 * Purpose: Tell whether the file of this episode still exists in the podcast's Drive folder, so a
 *   manual download can decide if the "already downloaded" flag is still true. Works for every
 *   file type (audio, video, documents, ...), not only for a fixed list of extensions.
 * Operation: The extension an episode was saved with is only known at download time and is not
 *   stored anywhere, so the lookup must not depend on it:
 *   1. Fast path – one exact-name lookup for the default `.mp3` name, which covers most episodes.
 *   2. Otherwise lists the folder once and accepts any file that `isEpisodeFileName` recognizes as
 *      this episode (the same base name under any extension).
 *   Returns true on any Drive error, so a transient failure can never clear the flag and cause a
 *   duplicate download.
 */
function episodeFileExistsInDrive(podcastTitle, episodeTitle, pubDate, runT0) {
  try {
    debugStep(
      'episodeFileExistsInDrive',
      debugSnippet(podcastTitle, 60) + ' / ' + debugSnippet(episodeTitle, 60),
      runT0
    );
    const folder = getPodcastFolder(podcastTitle || 'כללי');
    const d = pubDate instanceof Date ? pubDate : new Date(pubDate || Date.now());
    const defaultName = buildFileName(episodeTitle, d);
    if (folder.getFilesByName(defaultName).hasNext()) {
      debugStep('episodeFileExistsInDrive: found', defaultName, runT0);
      return true;
    }
    const it = folder.getFiles();
    while (it.hasNext()) {
      const name = it.next().getName();
      if (isEpisodeFileName(name, episodeTitle, d)) {
        debugStep('episodeFileExistsInDrive: found', name, runT0);
        return true;
      }
    }
    debugStep('episodeFileExistsInDrive: not found', defaultName, runT0);
    return false;
  } catch (_) {
    return true;
  }
}

/**
 * Purpose: Decide whether a filename found in a podcast folder belongs to the given episode,
 *   whatever type of file the episode turned out to be.
 * Operation: True when the name is exactly the episode's base name (`buildFileBaseName`) followed
 *   by a single dot and an extension made only of letters and digits – the same shape
 *   `buildFileName` produces. Requiring the extension to be the whole remainder keeps
 *   "260601 Ep.mp3" from matching a different episode whose title merely starts the same way,
 *   e.g. "260601 Ep. 2.mp3".
 */
function isEpisodeFileName(fileName, episodeTitle, pubDate) {
  const name = String(fileName || '');
  const prefix = buildFileBaseName(episodeTitle, pubDate) + '.';
  if (name.indexOf(prefix) !== 0) return false;
  return /^[a-z0-9]+$/i.test(name.slice(prefix.length));
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
  if (!episodeFileExistsInDrive(podcastTitle, episodeTitle, d, runT0)) {
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

/**
 * Purpose: Let the management dialog offer a direct "open my podcasts folder in Drive" link, so
 *   users can reach their downloaded files without searching Drive for the folder.
 * Operation: Resolves the root podcasts folder through `getRootFolder` (which creates it when it
 *   does not exist yet) and returns its Drive URL. The dialog calls this once when it opens, in
 *   a request of its own, so the Drive lookup never delays the podcast list.
 * @returns {string} - Drive URL of the root podcasts folder.
 */
function getPodcastsFolderUrl() {
  return getRootFolder().getUrl();
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
 * Operation: Takes the dated base name from `buildFileBaseName` and appends the given file
 *   extension (defaults to 'mp3'). The third argument is the extension, not a part number:
 *   episodes are always stored as a single complete file.
 */
function buildFileName(episodeTitle, pubDate, ext) {
  const safeExt = (ext && /^[a-z0-9]+$/i.test(ext)) ? ext : DEFAULT_FILE_EXTENSION;
  return `${buildFileBaseName(episodeTitle, pubDate)}.${safeExt}`;
}

/**
 * Purpose: Build the part of an episode's filename that does not depend on its file type, so that
 *   saving a file and later looking it up in Drive always agree on the name.
 * Operation: Formats the publication date as YYMMDD and appends the sanitized episode title,
 *   separated by a space. No extension and no trailing dot.
 */
function buildFileBaseName(episodeTitle, pubDate) {
  const dateStr = formatDateYYMMDD(pubDate || new Date());
  const safeTitle = sanitizeFileName(episodeTitle) || 'פרק';
  return `${dateStr} ${safeTitle}`;
}

// ============================================================
// LOGGING
// ============================================================

function writeLog(podcastTitle, episodeTitle, status, note, link) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['תאריך', 'הסכת', 'פרק', 'סטטוס', 'הערה', 'קישור']);
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
 * Purpose: Read the file extension written in a download URL, if it has one.
 * Operation: Drops the scheme and host (so a bare domain such as "example.com" is never mistaken
 *   for a file named "example" with extension "com"), the query string and the fragment, then
 *   returns whatever follows the last dot of the last path segment, lowercased. Returns '' when
 *   the path has no dot. The result is raw text – callers decide whether to trust it.
 * @param {string} url - Episode download URL.
 * @returns {string}   - Lowercase extension without the leading dot, or ''.
 */
function extractUrlExtension(url) {
  const path = String(url || '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/?#]*/i, '')
    .split('?')[0]
    .split('#')[0]
    .toLowerCase();
  const lastSeg = path.split('/').pop() || '';
  const dotIdx = lastSeg.lastIndexOf('.');
  return dotIdx >= 0 ? lastSeg.slice(dotIdx + 1) : '';
}

/**
 * Purpose: Read the MIME type a server declared for a response, in a form fit for table lookups.
 * Operation: Takes the Content-Type header, cuts any parameters after ';' (e.g. "; charset=utf-8"),
 *   trims and lowercases it. Returns '' when the header is missing.
 * @param {Object} headers - Response headers object.
 * @returns {string}       - Bare lowercase MIME type, or ''.
 */
function getResponseMimeType(headers) {
  const raw = String(getHeaderCaseInsensitive(headers || {}, 'Content-Type') || '');
  return raw.split(';')[0].trim().toLowerCase();
}

/**
 * Purpose: Detect the correct file extension for a podcast episode of ANY file type – audio,
 *   video, document, image, archive or anything else a feed links to – so the file is saved to
 *   Drive under its real type instead of being forced to '.mp3'.
 * Operation: Tries the following sources, most reliable first, and returns the first hit:
 *   1. The URL extension, when it is a type listed in `MIME_TYPE_BY_EXTENSION`.
 *   2. The server's Content-Type, matched exactly against `EXTENSION_BY_MIME_TYPE`.
 *   3. The server's Content-Type, matched loosely by keyword (non-standard audio types).
 *   4. The URL extension even though it is not a listed type, as long as it looks like a real
 *      extension (2-5 letters/digits with at least one letter) and is not the name of a
 *      server-side script (`NON_FILE_URL_EXTENSIONS`). This is what keeps unknown types intact.
 *   5. `DEFAULT_FILE_EXTENSION` ('mp3') when nothing above could be determined.
 * @param {string} url          - Episode download URL.
 * @param {Object} [headers]    - Optional response headers object from a prior probe request.
 * @returns {string}            - Lowercase file extension without the leading dot.
 */
function detectFileExtension(url, headers) {
  // 1. A URL extension of a known type is the most reliable signal
  let urlExt = '';
  try {
    urlExt = extractUrlExtension(url);
  } catch (_) { /* ignore */ }
  if (urlExt && Object.prototype.hasOwnProperty.call(MIME_TYPE_BY_EXTENSION, urlExt)) return urlExt;

  if (headers) {
    // 2. Exact Content-Type match
    const mimeType = getResponseMimeType(headers);
    if (mimeType && Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME_TYPE, mimeType)) {
      return EXTENSION_BY_MIME_TYPE[mimeType];
    }

    // 3. Loose Content-Type match for non-standard audio types
    const ct = String(getHeaderCaseInsensitive(headers, 'Content-Type') || '').toLowerCase();
    if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('mpeg4')) return 'm4a';
    if (ct.includes('mp3') || ct.includes('mpeg')) return 'mp3';
    if (ct.includes('ogg')) return 'ogg';
    if (ct.includes('opus')) return 'opus';
    if (ct.includes('aac')) return 'aac';
    if (ct.includes('wav')) return 'wav';
  }

  // 4. An unlisted URL extension still beats guessing, unless it names a server-side script
  if (/^[a-z0-9]{2,5}$/.test(urlExt) && /[a-z]/.test(urlExt) && !NON_FILE_URL_EXTENSIONS.includes(urlExt)) {
    return urlExt;
  }

  return DEFAULT_FILE_EXTENSION; // safe default
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

/**
 * Purpose: Tell a temporary server problem from a definite refusal, by HTTP status code.
 * Operation: True for 408 (request timeout), 429 (too many requests) and every 5xx (the server
 *   itself is failing). These usually pass on their own, so the request deserves a retry.
 *   Everything else – 403, 404, 410 and so on – is a definite answer and retrying right away
 *   would not change it.
 * @param {number} code - HTTP status code.
 * @returns {boolean}
 */
function isTransientHttpStatus(code) {
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

/**
 * Purpose: Turn a failed Google Drive response into an Error the download worker knows how to
 *   act on, instead of treating every Drive failure the same way.
 * Operation: Builds an Error with a Hebrew message and flags it by what Drive reported:
 *   - `isDriveFull`: 403 with reason `storageQuotaExceeded`. Nothing is wrong with the episode;
 *     the worker pauses the whole queue until space is freed.
 *   - `isNetworkRetryable`: a temporary status (see `isTransientHttpStatus`) or a 403 rate limit
 *     (`rateLimitExceeded` / `userRateLimitExceeded`). The worker retries shortly.
 *   - no flag: any other refusal; the worker counts it as a failed round for the episode.
 * @param {number} code     - HTTP status code Drive returned.
 * @param {string} bodyText - Response body (contains Drive's `reason`).
 * @param {string} prefix   - Hebrew description of the step that failed.
 * @returns {Error}
 */
function buildDriveHttpError(code, bodyText, prefix) {
  const body = String(bodyText || '');
  const lower = body.toLowerCase();
  const err = new Error(`${prefix}: HTTP ${code} – ${body.slice(0, 200)}`);
  if (code === 403 && lower.includes('storagequotaexceeded')) {
    err.isDriveFull = true;
  } else if (isTransientHttpStatus(code) || (code === 403 && lower.includes('ratelimitexceeded'))) {
    err.isNetworkRetryable = true;
  }
  return err;
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
 * @param {string} description  - Optional file description. If Drive refuses the request with
 *   a long description, the session is requested once more with the description cut short.
 * @returns {string}            - Session URL to use for subsequent chunk uploads.
 */
function createResumableUploadSession(fileName, mimeType, folderId, description) {
  const token = getOAuthToken();
  const metadata = { name: fileName, mimeType, parents: [folderId] };
  if (description) metadata.description = description;

  let resp = requestResumableUploadSession(token, mimeType, metadata);
  let code = resp.getResponseCode();

  // The description is already within the limit Drive shows in its own interface. That limit is
  // not in the API documentation, though, so should Drive refuse the request anyway, try once
  // more with a short description: an episode must never fail to download because of its notes.
  if ((code === 400 || code === 413) && description && description.length > FALLBACK_DESCRIPTION_LENGTH) {
    console.warn(
      'createResumableUploadSession: Drive refused the request (HTTP ' + code + ') with a ' +
      description.length + '-character description; retrying with a short one. ' +
      String(resp.getContentText() || '').slice(0, 200)
    );
    metadata.description = truncateText(description, FALLBACK_DESCRIPTION_LENGTH);
    resp = requestResumableUploadSession(token, mimeType, metadata);
    code = resp.getResponseCode();
  }

  if (code !== 200) {
    throw buildDriveHttpError(code, resp.getContentText(), 'יצירת סשן העלאה נכשלה');
  }

  const location = getHeaderCaseInsensitive(resp.getHeaders(), 'Location');
  if (!location) {
    throw new Error('שרת Drive לא החזיר Location header עבור סשן ההעלאה');
  }
  return location;
}

/**
 * Purpose: Send the single request that opens a Drive resumable upload session.
 * Operation: POSTs the file metadata to the Drive API v3 resumable upload endpoint and returns
 *   the raw response for `createResumableUploadSession` to interpret. A request that never got
 *   an answer (DNS, timeout, ...) is rethrown flagged `isNetworkRetryable`, so the worker tries
 *   the episode again shortly.
 * @param {string} token    - OAuth token.
 * @param {string} mimeType - MIME type of the file that will be uploaded.
 * @param {Object} metadata - Drive file metadata (name, mimeType, parents, description).
 * @returns {HTTPResponse}
 */
function requestResumableUploadSession(token, mimeType, metadata) {
  try {
    return UrlFetchApp.fetch(
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
  } catch (e) {
    // The request never got an answer (DNS, timeout, ...) – worth another attempt.
    const err = new Error(`שגיאת רשת ביצירת סשן העלאה: ${e.message || String(e)}`);
    err.isNetworkRetryable = true;
    throw err;
  }
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
 * Purpose: A modular engine to resolve bloat-URLs that crash UrlFetchApp (>2048 chars).
 * Triggered by the DFS Backtracking engine in fetchWithRedirects when UrlFetchApp throws an error.
 * 
 * HOW TO ADD A NEW STRATEGY (e.g., Strategy 3):
 * 1. Add an `else if (strategyIndex === 3) { ... }` block below.
 * 2. IMPORTANT: You MUST go to `fetchWithRedirects` and update `const MAX_STRATEGIES = 3;` 
 *    Otherwise, the DFS backtracking loop will never reach your new strategy!
 *
 * @param {string} failedUrl - The URL that caused the fetch to fail.
 * @param {number} strategyIndex - The specific strategy number (1, 2, 3...) to attempt.
 * @returns {string|null} - A safe alternative URL if the strategy matches, else null.
 */
function attemptUrlBypassStrategy(failedUrl, strategyIndex) {
  if (strategyIndex === 1) {
    // Strategy 1: Fallback URL (fu) extraction (Common in Triton Digital / Omny / Megaphone)
    // Many ad-tech providers nest the clean audio URL inside a 'fu' or 'fallback' query parameter.
    try {
      const fuMatch = failedUrl.match(/[?&]fu=([^&]+)/);
      if (fuMatch && fuMatch[1]) {
        const decodedFu = decodeURIComponent(fuMatch[1]);
        if (decodedFu.startsWith('http')) {
          console.log(`[URL Bypass] Strategy 1 triggered: Extracted valid 'fu' fallback URL.`);
          return decodedFu;
        }
      }
    } catch(e) {
      console.error(`[URL Bypass] Strategy 1 parsing error: ${e.message}`);
    }
  } else if (strategyIndex === 2) {
    // Strategy 2: Omny Studio / Triton Digital Direct CDN Extraction
    // Omny tracking URLs can exceed 2048 characters due to heavy metadata.
    // We can extract the core IDs and bypass to their direct CDN.
    try {
      const omnyMatch = failedUrl.match(/\b(?:omny-us\.pdn\.tritondigital\.com\/v1\/download|traffic\.omny\.fm\/d\/clips)\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)/i);
      if (omnyMatch && omnyMatch.length === 4) {
        const cleanUrl = `https://www.omnycontent.com/d/clips/${omnyMatch[1]}/${omnyMatch[2]}/${omnyMatch[3]}/audio.mp3`;
        console.log(`[URL Bypass] Strategy 2 triggered: Reconstructed clean Omny CDN URL.`);
        return cleanUrl;
      }
    } catch(e) {
      console.error(`[URL Bypass] Strategy 2 parsing error: ${e.message}`);
    }
  }
  
  // Strategy 3: [Add new strategies above and update MAX_STRATEGIES in fetchWithRedirects]
  return null;
}

/**
 * Purpose: Follows HTTP redirects manually while preserving custom headers (like Range).
 *   UrlFetchApp's native followRedirects drops custom headers across domains.
 * @returns {{ response: HTTPResponse, finalUrl: string }}
 */
function fetchWithRedirects(url, options, maxRedirects) {
  let currentUrl = url;
  let redirects = maxRedirects || 20;
  const opts = Object.assign({}, options);
  opts.followRedirects = false;
  
  const bypassStack = [];
  const MAX_STRATEGIES = 2; // IMPORTANT: Increase this if you add new strategies in attemptUrlBypassStrategy()
  
  while (redirects > 0) {
    let resp;
    try {
      resp = UrlFetchApp.fetch(currentUrl, opts);
    } catch (e) {
      console.warn(`[URL Bypass] UrlFetchApp fetch failed. Error: ${e.message}. Attempting to run bypass engine...`);
      
      // Is this crashing URL already on the top of the stack?
      if (bypassStack.length === 0 || bypassStack[bypassStack.length - 1].url !== currentUrl) {
        // Check if it's already in the stack somewhere else (a cycle)
        const cycleIndex = bypassStack.findIndex(item => item.url === currentUrl);
        if (cycleIndex !== -1) {
          console.warn(`[URL Bypass] Cycle detected for URL. Backtracking...`);
        } else {
          // New crashing URL. Push it to the stack.
          bypassStack.push({ url: currentUrl, strategyIndex: 0 });
        }
      }
      
      let bypassedUrl = null;
      while (bypassStack.length > 0) {
        const top = bypassStack[bypassStack.length - 1];
        if (top.strategyIndex < MAX_STRATEGIES) {
          top.strategyIndex++;
          bypassedUrl = attemptUrlBypassStrategy(top.url, top.strategyIndex);
          if (bypassedUrl) {
            break; // Found a branch to explore!
          }
        } else {
          // Exhausted all strategies for this URL. Pop it and backtrack.
          bypassStack.pop();
          console.log(`[URL Bypass] Exhausted all strategies for URL, backtracking...`);
        }
      }
      
      if (bypassedUrl) {
        console.log(`[URL Bypass] Bypass successful via strategy. Resuming fetch with safe URL (Length: ${bypassedUrl.length})`);
        currentUrl = bypassedUrl;
        continue;
      }
      
      console.error(`[URL Bypass] Exhausted all bypass strategies (Backtracking failed). Re-throwing original error.`);
      throw e;
    }
    
    const code = resp.getResponseCode();
    if (code >= 300 && code < 400) {
      const location = getHeaderCaseInsensitive(resp.getHeaders(), 'Location');
      if (location) {
        if (location.startsWith('/')) {
          const match = currentUrl.match(/^https?:\/\/[^\/]+/);
          currentUrl = (match ? match[0] : '') + location;
        } else {
          currentUrl = location;
        }
        redirects--;
        continue;
      }
    }
    return { response: resp, finalUrl: currentUrl };
  }
  throw new Error(`חריגה ממספר ההפניות (Too many redirects) עבור: ${url}`);
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
  let ext = DEFAULT_FILE_EXTENSION;
  let probeMimeType = '';
  let directUrl = episodeUrl;
  try {
    const probeResult = fetchWithRedirects(episodeUrl, {
      headers: { Range: 'bytes=0-0' },
      muteHttpExceptions: true
    });
    const probeResp = probeResult.response;
    directUrl = probeResult.finalUrl;
    
    const probeHeaders = probeResp.getHeaders() || {};
    const fromRange = parseTotalSizeFromContentRange(probeHeaders);
    const fromCl = parseContentLength(probeHeaders);
    totalSize = fromRange !== null ? fromRange : fromCl;
    ext = detectFileExtension(directUrl, probeHeaders);
    probeMimeType = getResponseMimeType(probeHeaders);
    debugStep('downloadResumable: probe done', `size=${totalSize} ext=${ext} type=${probeMimeType}`, runT0);
  } catch (e) {
    debugStep('downloadResumable: probe failed (continuing without size)', e.message || String(e), runT0);
  }

  // A listed extension decides the Drive MIME type. For any other file type, pass on what the
  // server declared, and only as a last resort mark the file as generic binary data.
  const mimeType = (Object.prototype.hasOwnProperty.call(MIME_TYPE_BY_EXTENSION, ext) && MIME_TYPE_BY_EXTENSION[ext])
    || probeMimeType
    || 'application/octet-stream';
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
  // Always trust Google Drive's reported progress as the absolute source of truth.
  // This prevents mismatches and permanent failures if a hard timeout prevented the queue from updating.
  let offset = uploadedBytes; // align download cursor with confirmed uploads

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
      const chunkResult = fetchWithRedirects(directUrl, {
        headers: { Range: `bytes=${offset}-${rangeEnd}` },
        muteHttpExceptions: true
      });
      downloadResp = chunkResult.response;
      directUrl = chunkResult.finalUrl;
    } catch (e) {
      const err = new Error(`שגיאת רשת בהורדת chunk ${chunkIndex}: ${e.message}`);
      err.isNetworkRetryable = true;
      err.resumeSessionUrl = sessionUrl; // keep what Drive already received for the retry
      throw err;
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
      const err = new Error(`HTTP ${downloadCode} בעת הורדת chunk ${chunkIndex} מהשרת`);
      // A podcast server that is overloaded or briefly down (5xx / 429 / 408) is as temporary as
      // a network error and gets the same retries. 403 / 404 and the like are final for this round.
      if (isTransientHttpStatus(downloadCode)) {
        err.isNetworkRetryable = true;
        err.resumeSessionUrl = sessionUrl;
      }
      throw err;
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
      const msg = e.message || String(e);
      if (msg.includes('UrlFetch') && (msg.includes('רוחב פס') || msg.toLowerCase().includes('bandwidth'))) {
        debugStep('downloadResumable: upload bandwidth limit hit (triggering soft stop)', `offset=${offset}`, runT0);
        const err = new Error('TIME_BUDGET_EXCEEDED');
        err.code = 'TIME_BUDGET_EXCEEDED';
        err.resumeOffset = offset;
        err.resumeSessionUrl = sessionUrl;
        throw err;
      }
      const err = new Error(`שגיאת רשת בהעלאת chunk ${chunkIndex} לדרייב: ${msg}`);
      err.isNetworkRetryable = true;
      err.resumeSessionUrl = sessionUrl;
      throw err;
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
      const err = buildDriveHttpError(uploadCode, uploadResp.getContentText(), `שגיאה בהעלאת chunk ${chunkIndex} לדרייב`);
      // Keep the session so a retry (or a resume after space is freed) continues from the bytes
      // Drive already holds; `queryResumableSessionProgress` starts over if the session is gone.
      err.resumeSessionUrl = sessionUrl;
      throw err;
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
 * `description` is the plain-text form made by `descriptionToPlainText` (line breaks kept, links
 * written out, at most MAX_DESCRIPTION_LENGTH characters); it is what gets stored on the queued
 * job and on the Drive file. When `options.includeFullDescription` is true every episode also
 * gets `descriptionHtml`: the description exactly as the feed gives it, with its markup, for
 * display in the management dialog. It is opt-in so the automatic scan does not carry it around.
 */
function parseRSS(xmlUrl, runT0, subscriptionDateMs, options) {
  const includeFullDescription = !!(options && options.includeFullDescription);
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
    let descriptionHtml = '';
    try {
      const descEl = item.getChild('description');
      descriptionHtml = descEl ? descEl.getValue().trim() : '';
      description = descriptionToPlainText(descriptionHtml);
    } catch (_) { /* ignore */ }

    const episode = {
      title: (item.getChildText('title') || 'ללא שם').trim(),
      date: dateText,
      description,
      url
    };
    if (includeFullDescription) episode.descriptionHtml = descriptionHtml;
    episodes.push(episode);
  }

  debugStep('parseRSS: items', String(episodes.length) + ' episodes', runT0);
  return { title: podcastTitle, imageUrl, episodes };
}

/**
 * Purpose: Turn an episode description from a feed (plain text or HTML) into readable plain
 *   text, for places that cannot show markup: the description of the file in Drive and the
 *   queued download job.
 * Operation: Works on the text with a fixed sequence of replacements:
 *   1. Scripts and style sheets are removed together with their content.
 *   2. If the text has line-break markup of its own (paragraphs, <br>, list items...), the line
 *      breaks typed in the source are only formatting of the markup and are collapsed to spaces.
 *      Text without such markup keeps its typed line breaks.
 *   3. A link becomes its text followed by the address in brackets – "text (https://...)" – or
 *      just the address when the two are the same; only http/https addresses are written out.
 *   4. <br> becomes a line break, a list item starts a new line with a bullet, the end of a
 *      paragraph leaves an empty line, and the end of any other block ends the line. (The end
 *      of a list item adds nothing: the next item or the end of the list already breaks the line.)
 *   5. All remaining tags are removed and the common character entities are decoded.
 *   6. Spaces at line ends are trimmed, more than one empty line in a row is reduced to one, and
 *      the result is cut to MAX_DESCRIPTION_LENGTH characters (ending with "…" when cut).
 * @param {string} html - Description as the feed gives it.
 * @returns {string} - Plain text.
 */
function descriptionToPlainText(html) {
  let text = String(html || '');

  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');

  if (/<(br|p|div|li|h[1-6]|blockquote|tr)\b/i.test(text)) {
    text = text.replace(/\s+/g, ' ');
  }

  text = text.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (match, quote, href, label) => {
    const linkText = label.replace(/<[^>]*>/g, '').trim();
    const address = href.trim();
    if (!/^https?:/i.test(address)) return linkText;
    if (!linkText || linkText === address) return address;
    return linkText + ' (' + address + ')';
  });

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/(div|h[1-6]|ul|ol|tr|blockquote|section|article|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(#39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (match, digits) => decodeNumericEntity(match, parseInt(digits, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => decodeNumericEntity(match, parseInt(hex, 16)))
    .replace(/&amp;/gi, '&');

  text = text
    .replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return truncateText(text, MAX_DESCRIPTION_LENGTH);
}

/**
 * Purpose: Decode one numeric character entity (such as "&#1513;") without ever throwing, so a
 *   malformed entity in a feed cannot fail the handling of the episode it belongs to.
 * Operation: Returns the character for a valid code point. A number that is not a valid code
 *   point (zero, or above the Unicode range) leaves the entity text as it was written.
 * @param {string} entity - The entity as written in the text.
 * @param {number} codePoint - The number the entity holds.
 * @returns {string}
 */
function decodeNumericEntity(entity, codePoint) {
  if (!(codePoint > 0 && codePoint <= 0x10FFFF)) return entity;
  return String.fromCodePoint(codePoint);
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

/**
 * Purpose: Return a podcast's episode list for the management dialog, with each episode marked
 *   as already downloaded and/or currently waiting in the download queue, so the dialog can show
 *   that up front instead of the user finding out only after clicking "download".
 * Operation: Parses the feed with `parseRSS`, then reads the downloads sheet and the queue sheet
 *   once each and adds two booleans to every episode: `downloaded` and `queued`. No Drive call is
 *   made: `downloaded` means "was downloaded at some point", not "the file is still in Drive" –
 *   that check stays on the manual download click (`syncDownloadedFlagWithDrive`), where it costs
 *   one lookup instead of one per listed episode. If the two sheets cannot be read, the episodes
 *   are returned without flags rather than failing the whole list. For descriptions the dialog
 *   gets `descriptionHtml` (the description as the feed gives it, which it displays) and a
 *   `hasDescription` flag; the plain-text `description` is left out so that each description
 *   travels once. On a manual download the dialog sends `descriptionHtml` back and
 *   `downloadEpisode` converts it to plain text itself.
 * @param {string} rssUrl - Feed URL of the podcast.
 * @returns {{ success: boolean, title?: string, imageUrl?: string, episodes?: Array<Object>,
 *             error?: string }}
 */
function fetchEpisodeList(rssUrl) {
  try {
    const data = parseRSS(rssUrl, undefined, undefined, { includeFullDescription: true });
    let episodes = data.episodes.map(ep => ({
      title: ep.title,
      date: ep.date,
      url: ep.url,
      descriptionHtml: ep.descriptionHtml,
      hasDescription: !!ep.description
    }));
    try {
      const downloadedUrls = getDownloadedSet();
      const queuedUrls = getQueuedEpisodeUrls();
      episodes = episodes.map(ep => Object.assign({}, ep, {
        downloaded: downloadedUrls.has(ep.url),
        queued: queuedUrls.has(ep.url)
      }));
    } catch (flagError) {
      console.warn('fetchEpisodeList: could not read download status: ' + flagError.message);
    }
    return { success: true, title: data.title, imageUrl: data.imageUrl, episodes: episodes };
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
 * @param {Object} episodeData - { url, title, date, descriptionHtml, podcastTitle }.
 *   `descriptionHtml` is the description as the feed gives it; it is converted here with
 *   `descriptionToPlainText` before it is stored on the job (and later on the Drive file).
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

    // The user asked for this episode explicitly: forget earlier failures so it gets a full set
    // of attempts again (also re-enables automatic retries if the scan had given up on it).
    clearEpisodeFailure(episodeData.url);

    // Enqueue the job with manualDownload=true so the worker logs it as "הורד ידנית"
    enqueueDownloadJob({
      podcastTitle: episodeData.podcastTitle || 'כללי',
      episodeUrl:   episodeData.url,
      episodeTitle: episodeData.title || 'פרק',
      pubDate:      pubDate.toISOString(),
      description:  descriptionToPlainText(episodeData.descriptionHtml),
      manualDownload: true
    });

    // Schedule the worker in 1 minute (shorter delays get throttled by the Apps Script scheduler)
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

/** iTunes podcast search – runs server-side */
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

/** Logs the dual search results from the client side into the GAS execution logs */
function logDualSearchResults(logData) {
  console.log(`[Dual Search] Query: "${logData.query}"`);
  console.log(`[Dual Search] iTunes found: ${logData.itunesCount}`);
  if (logData.itunesTitles && logData.itunesTitles.length > 0) {
    console.log(`[Dual Search] iTunes Top Results: \n` + logData.itunesTitles.join('\n'));
  }
  
  console.log(`[Dual Search] Podcast Index found: ${logData.piCount}`);
  if (logData.piTitles && logData.piTitles.length > 0) {
    console.log(`[Dual Search] Podcast Index Top Results: \n` + logData.piTitles.join('\n'));
  }
  
  console.log(`[Dual Search] Combined Unique Results shown to user: ${logData.combinedCount}`);
}

/** 
 * Podcast Index Auth Headers for client-side dual search.
 * Computes the required SHA-1 authorization signature dynamically.
 */
function getPodcastIndexAuthHeaders() {
  let keys = null;
  // Prefer the secret keys file if it exists (clasp pushes it, but git ignores it).
  // Otherwise fallback to the open source template file keys.
  if (this.getPodcastIndexKeys_Secret) {
    keys = this.getPodcastIndexKeys_Secret();
  } else if (this.getPodcastIndexKeys_Template) {
    keys = this.getPodcastIndexKeys_Template();
  }

  if (!keys || !keys.apiKey || !keys.apiSecret || keys.apiKey === "YOUR_API_KEY") {
    return null; // Signals the client-side to skip PI search silently
  }

  const authDate = Math.floor(Date.now() / 1000).toString();
  const data = keys.apiKey + keys.apiSecret + authDate;
  const signatureBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, data);
  const signatureHex = signatureBytes.map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0')).join('');

  return {
    "X-Auth-Date": authDate,
    "X-Auth-Key": keys.apiKey,
    "Authorization": signatureHex,
    "User-Agent": "Podcast-to-Drive/1.0"
  };
}

// ============================================================
// OPML IMPORT
// ============================================================

function importOPML(opmlText) {
  try {
    console.log('importOPML: מתחיל בניתוח טקסט ה-OPML');
    const doc = XmlService.parse(sanitizeXmlForParsing(opmlText));
    const root = doc.getRootElement();
    const body = root.getChild('body');
    if (!body) return { success: false, error: 'קובץ OPML לא תקין – חסר אלמנט body' };

    const feeds = [];
    collectFeedsFromOutlines(body, feeds);

    if (feeds.length === 0) {
      console.warn('importOPML: לא נמצאו הסכתים בקובץ ה-OPML');
      return { success: false, error: 'לא נמצאו feeds בקובץ ה-OPML' };
    }

    console.log(`importOPML: נמצאו ${feeds.length} הסכתים בקובץ. מתחיל ייבוא...`);

    const BATCH_SIZE = 50;
    const finalSubscriptions = [];

    for (let i = 0; i < feeds.length; i += BATCH_SIZE) {
      const batch = feeds.slice(i, i + BATCH_SIZE);
      console.log(`importOPML: מעבד מקבץ ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} הסכתים)...`);
      
      // Pre-filter bad URLs to prevent them from crashing the entire fetchAll batch
      const requests = batch.map(feed => {
        if (!/^https?:\/\//i.test(feed.url)) {
          return { url: 'https://google.com', muteHttpExceptions: true }; // dummy valid URL
        }
        return { url: feed.url, muteHttpExceptions: true };
      });

      let responses = [];
      try {
        responses = UrlFetchApp.fetchAll(requests);
      } catch (e) {
        console.warn(`importOPML: שגיאה בשליפת מקבץ במקביל, מנסה באופן טורי... ${e.message}`);
        // Fallback: If fetchAll fails (e.g. DNS error on one of the URLs), fetch sequentially
        responses = batch.map(feed => {
          try {
            if (!/^https?:\/\//i.test(feed.url)) return null;
            return UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true });
          } catch (err) {
            return null; // Ignore individual DNS/timeout errors
          }
        });
      }

      batch.forEach((feed, index) => {
        const resp = responses[index];
        let xmlText = '';
        if (resp && typeof resp.getResponseCode === 'function' && resp.getResponseCode() < 400) {
          xmlText = resp.getContentText();
        }
        
        const meta = parseXmlForMetadata(xmlText);
        const finalTitle = meta.title || feed.title || feed.url;
        const finalImage = meta.imageUrl || '';
        
        finalSubscriptions.push({
          url: feed.url,
          title: finalTitle,
          imageUrl: finalImage
        });
      });
    }

    const result = addMultipleSubscriptions(finalSubscriptions);
    const added = result.added || 0;
    const skipped = result.skipped || 0;

    console.log(`importOPML: הייבוא הושלם. נוספו: ${added}, דולגו: ${skipped}.`);
    return { success: true, added, skipped };
  } catch (e) {
    console.error(`importOPML: שגיאה בניתוח OPML: ${e.message}`, e.stack);
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
// OPML IMPORT FROM DRIVE & AUTO BACKUP
// ============================================================

function findLatestOPMLInDrive() {
  try {
    const root = getRootFolder();
    const it = root.searchFiles('trashed = false and title contains ".opml"');
    let latestFile = null;
    let latestTime = 0;
    while (it.hasNext()) {
      const file = it.next();
      const time = file.getLastUpdated().getTime();
      if (time > latestTime) {
        latestTime = time;
        latestFile = file;
      }
    }
    if (latestFile) {
      return { 
        success: true, 
        found: true, 
        id: latestFile.getId(), 
        name: latestFile.getName(), 
        date: latestFile.getLastUpdated().toISOString() 
      };
    }
    return { success: true, found: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function importOPMLFromDrive(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    // basic security: make sure it's in the podcast root folder
    const parents = file.getParents();
    let inRoot = false;
    const rootId = getRootFolder().getId();
    while (parents.hasNext()) {
      if (parents.next().getId() === rootId) {
        inRoot = true;
        break;
      }
    }
    if (!inRoot) {
      return { success: false, error: 'הקובץ לא נמצא בתיקיית הסכתים.' };
    }
    const content = file.getBlob().getDataAsString();
    return importOPML(content);
  } catch (e) {
    return { success: false, error: 'שגיאה בקריאת הקובץ מהדרייב: ' + e.message };
  }
}

const PROP_AUTO_OPML_TRIG = 'autoOpmlTrigId';

function scheduleAutoOpmlBackup() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_AUTO_OPML_TRIG);
  if (id) {
    ScriptApp.getProjectTriggers()
      .filter(t => t.getUniqueId() === id)
      .forEach(t => ScriptApp.deleteTrigger(t));
  }
  const trig = ScriptApp.newTrigger('autoExportOPML').timeBased().after(2 * 60 * 1000).create();
  props.setProperty(PROP_AUTO_OPML_TRIG, trig.getUniqueId());
}

function autoExportOPML() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_AUTO_OPML_TRIG);
  if (id) {
    ScriptApp.getProjectTriggers()
      .filter(t => t.getUniqueId() === id)
      .forEach(t => ScriptApp.deleteTrigger(t));
    props.deleteProperty(PROP_AUTO_OPML_TRIG);
  }
  
  exportOPML();
  cleanupOldOPMLs();
}

function cleanupOldOPMLs() {
  const root = getRootFolder();
  const it = root.searchFiles('trashed = false and title contains ".opml"');
  const files = [];
  while (it.hasNext()) {
    files.push(it.next());
  }
  files.sort((a, b) => b.getLastUpdated().getTime() - a.getLastUpdated().getTime());
  
  for (let i = 1; i < files.length; i++) {
    files[i].setTrashed(true);
  }
}

// ============================================================
// OPML EXPORT
// ============================================================

function exportOPML() {
  try {
    console.log('exportOPML: מתחיל ייצוא OPML לגיבוי');
    const subs = getSubscriptions();
    const entries = Object.entries(subs);
    if (entries.length === 0) {
      console.warn('exportOPML: אין מנויים לייצוא');
      return { success: false, error: 'אין מנויים לייצוא' };
    }

    const dateStr = formatDateYYMMDD(new Date());
    const escAttr = s => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    console.log(`exportOPML: מייצר קובץ XML עבור ${entries.length} הסכתים...`);

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
    
    console.log(`exportOPML: שומר את הקובץ ${fileName} לתיקיית ההסכתים בדרייב...`);
    const blob = Utilities.newBlob(xml, 'text/x-opml; charset=UTF-8', fileName);
    const file = folder.createFile(blob);

    console.log(`exportOPML: הקובץ נשמר בהצלחה! מזהה קובץ: ${file.getId()}`);

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
  // Read-only snapshots for this scan. The scan never writes the downloads sheet back: it does not
  // change it, and rewriting a snapshot taken minutes ago would erase episodes the worker finished
  // in the meantime (they would then be downloaded a second time).
  const downloadedSet = getDownloadedSet();
  debugStep('podcastManager: downloaded URL set', 'size=' + downloadedSet.size, runT0);
  // Episodes already waiting in the queue (not re-queued) and how often each episode has failed.
  const queuedUrls = getQueuedEpisodeUrls();
  const failureCounts = getEpisodeFailureCounts();
  debugStep('podcastManager: queue / failures', `queued=${queuedUrls.size} failing=${failureCounts.size}`, runT0);
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

  const checkpointProgress = (state) => {
    debugStep('podcastManager: checkpoint', debugSnippet(JSON.stringify(state), 200), runT0);
    props.setProperty(PROP_RESUME, JSON.stringify(state));
  };

  const requestSoftStop = (state) => {
    debugStep('podcastManager: requestSoftStop (soft time budget)', debugSnippet(JSON.stringify(state), 250), runT0);
    checkpointProgress(state);
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
      requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: 0 });
      break;
    }

    // Fetch RSS
    let episodes = [];
    try {
      const parsed = parseRSS(rssUrl, runT0, subData.subscribeDate || 0);
      // Update cached title and image if podcast renamed itself or missing artwork
      if (parsed.title && parsed.title !== subData.title) {
        subs[rssUrl].title = parsed.title;
      }
      if (parsed.imageUrl && parsed.imageUrl !== subData.imageUrl) {
        subs[rssUrl].imageUrl = parsed.imageUrl;
      }
      episodes = parsed.episodes;
      debugStep('podcastManager: episodes after date filter', 'count=' + episodes.length, runT0);
    } catch (e) {
      debugStep('podcastManager: parseRSS failed', e.message || String(e), runT0);
      writeLog(subData.title, '—', 'שגיאת RSS', e.message);
      continue;
    }
    if (shouldStop()) {
      requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: 0 });
      break;
    }

    for (let ei = startEi_; ei < episodes.length; ei++) {
      const ep = episodes[ei];

      // ── Time check ──────────────────────────────────────────
      if (shouldStop()) {
        requestSoftStop({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei, episodeUrl: ep.url });
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
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 });
        continue;
      }
      // Already waiting in the queue (e.g. the queue is paused because Drive is full, or the worker
      // has not reached it yet): queuing it again would only pile up duplicate rows.
      if (queuedUrls.has(ep.url)) {
        debugStep('podcastManager: skip (already in queue)', debugSnippet(ep.url, 100), runT0);
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 });
        continue;
      }
      // Failed in too many rounds: stop retrying automatically. A manual download resets this.
      if ((failureCounts.get(ep.url) || 0) >= MAX_EPISODE_FAILURES) {
        debugStep('podcastManager: skip (gave up after repeated failures)', debugSnippet(ep.url, 100), runT0);
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 });
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
        queuedUrls.add(ep.url);
        debugStep('podcastManager: enqueued episode', debugSnippet(ep.title, 80), runT0);
        resumeState = null;
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 });
      } catch (e) {
        debugStep('podcastManager: enqueue error', (e.message || String(e)).slice(0, 200), runT0);
        const msg = e.message || '';
        if (msg.toLowerCase().includes('storage') || msg.toLowerCase().includes('quota')) {
          writeLog(subData.title, ep.title, 'שגיאה', 'נכשל בהכנסה לתור – חריגה באחסון');
          driveFull = true;
          break;
        }
        writeLog(subData.title, ep.title, 'שגיאה', msg);
        checkpointProgress({ podcastUrl: rssUrl, podcastIndex: pi, episodeIndex: ei + 1 });
      }
    }
    if (stopRequested) break;
    checkpointProgress({ podcastIndex: pi + 1, episodeIndex: 0 });
  }

  if (stopRequested) {
    if (getDownloadQueueLength() > 0) {
      scheduleDownloadWorkerAfterMs(60 * 1000);
    }
    debugStep('podcastManager: exit (stopRequested / resume scheduled)', null, runT0);
    return;
  }

  // 3. Save updated metadata
  debugStep('podcastManager: syncActiveSubscriptionsMetadata', null, runT0);
  syncActiveSubscriptionsMetadata(subs);

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
 * Operation: Reads the head of the queue, downloads it with the resumable engine, records the
 *   result and schedules itself again while items remain. What happens on failure depends on
 *   the kind of failure:
 *   - Time budget exceeded: saves the upload position and continues in the next run.
 *   - Drive is full: nothing is wrong with the episode. The queue is left untouched and the
 *     worker is NOT rescheduled, so one Log row is written instead of one per waiting episode;
 *     the next scan (or manual download) starts the worker again.
 *   - Temporary problem (network error, server 5xx / 429 / 408): retried in the next run, up to
 *     `MAX_TRANSIENT_RETRIES` times.
 *   - Anything else, or retries exhausted: the episode leaves the queue and one failed round is
 *     counted for it (`recordEpisodeFailure`). The next scan queues it again, until it has
 *     failed `MAX_EPISODE_FAILURES` rounds – then the scan stops trying.
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
    clearEpisodeFailure(job.episodeUrl);
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
      job.networkRetries = 0; // Reset retries on successful soft-stop progress
      updateDownloadQueueHead(job);
      debugStep('downloadWorker: soft-stop resume saved', debugSnippet(JSON.stringify(job), 200), runT0);
    } else if (e && e.isDriveFull) {
      // Not the episode's fault, and every other queued episode would fail the same way. Keep the
      // queue as it is and stop here; the next scan or manual download restarts the worker.
      if (e.resumeSessionUrl !== undefined) {
        job.resumeSessionUrl = e.resumeSessionUrl;
        updateDownloadQueueHead(job);
      }
      writeLog(podcastTitle, job.episodeTitle || 'פרק', 'שגיאה',
        `האחסון ב-Drive מלא. ההורדות מושהות (${getDownloadQueueLength()} פרקים ממתינים בתור) ויתחדשו אוטומטית בבדיקה הבאה לאחר שיתפנה מקום.`);
      deleteDownloadWorkerTrigger();
      debugStep('downloadWorker: Drive full – queue paused', 'queue=' + getDownloadQueueLength(), runT0);
      return;
    } else if (e && e.isNetworkRetryable) {
      job.networkRetries = (job.networkRetries || 0) + 1;
      const msg = e.message || String(e);
      if (job.networkRetries <= MAX_TRANSIENT_RETRIES) {
        // Keep the Drive session (when the error carries one) so the retry resumes the upload.
        if (e.resumeSessionUrl !== undefined) job.resumeSessionUrl = e.resumeSessionUrl;
        updateDownloadQueueHead(job);
        writeLog(podcastTitle, job.episodeTitle || 'פרק', 'אזהרה', `שגיאה זמנית, ניסיון ${job.networkRetries} מתוך ${MAX_TRANSIENT_RETRIES}. ממתין לריצה הבאה... (${msg})`);
        debugStep('downloadWorker: temporary error, retry scheduled', `retries=${job.networkRetries}`, runT0);
      } else {
        failEpisodeRound(job, podcastTitle, `נכשל לאחר ${MAX_TRANSIENT_RETRIES} ניסיונות חוזרים עקב שגיאה זמנית. ${msg}`, runT0);
      }
    } else {
      const msg = e && e.message ? e.message : String(e);
      const note = (msg.includes('Range requests') || msg.includes('מגבלת UrlFetch'))
        ? 'לא ניתן להוריד – הקובץ גדול מדי והשרת אינו תומך בחלוקה לחלקים (Range)'
        : msg;
      failEpisodeRound(job, podcastTitle, note, runT0);
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

/**
 * Purpose: Close a failed download round for the episode at the head of the queue.
 * Operation: Writes the error to the Log, counts one more failed round for the episode and
 *   removes it from the queue. When the count reaches `MAX_EPISODE_FAILURES` a second Log row
 *   tells the user that automatic retries have stopped and how to try again.
 */
function failEpisodeRound(job, podcastTitle, note, runT0) {
  const episodeTitle = job.episodeTitle || 'פרק';
  writeLog(podcastTitle, episodeTitle, 'שגיאה', note);
  const failures = recordEpisodeFailure(job.episodeUrl, podcastTitle, episodeTitle, note);
  if (failures === MAX_EPISODE_FAILURES) {
    writeLog(podcastTitle, episodeTitle, 'שגיאה',
      `ההורדה נכשלה ${MAX_EPISODE_FAILURES} פעמים ברצף ולכן לא תנוסה שוב אוטומטית. אפשר לנסות שוב ידנית מתוך מנהל ההסכתים.`);
  }
  shiftDownloadQueue();
  debugStep('downloadWorker: failed and removed from queue', `failures=${failures} ` + debugSnippet(note, 160), runT0);
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
  installTrigger();
  SpreadsheetApp.getUi().alert('✓ ההרשאות אושרו בהצלחה! כעת אפשר להוסיף הסכתים מתפריט 🎙 הסכתים למעלה.');
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
