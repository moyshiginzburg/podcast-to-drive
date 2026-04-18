// ============================================================
// PODCAST MANAGER FOR GOOGLE DRIVE
// Based on: https://www.labnol.org/auto-download-podcasts-google-drive-220503
// ============================================================

// --- Constants ---
const ROOT_FOLDER_NAME = 'הסכתים';
const LOG_SHEET_NAME = 'Log';
const PROP_SUBSCRIPTIONS = 'subscriptions';
const PROP_DOWNLOADED = 'downloadedUrls';
const PROP_LAST_RUN = 'lastRunTime';
const PROP_RESUME = 'resumeState';
const PROP_ONE_TIME_TRIG = 'oneTimeTrigId';
const CHUNK_SIZE = 40 * 1024 * 1024; // 40 MB
const URL_FETCH_RESPONSE_LIMIT = 50 * 1024 * 1024; // Apps Script UrlFetch response cap

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
    .setTitle('🎙 מנהל הסכתים');
  SpreadsheetApp.getUi().showSidebar(html);
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

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function getSubscriptions() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_SUBSCRIPTIONS);
  return raw ? JSON.parse(raw) : {};
}

function saveSubscriptions(subs) {
  PropertiesService.getScriptProperties().setProperty(
    PROP_SUBSCRIPTIONS, JSON.stringify(subs)
  );
}

/** Returns array of { url, title, imageUrl, subscribeDate } */
function getSubscriptionsList() {
  const subs = getSubscriptions();
  return Object.entries(subs).map(([url, data]) => ({
    url,
    title: data.title || url,
    imageUrl: data.imageUrl || '',
    subscribeDate: data.subscribeDate || 0
  }));
}

/** Called from sidebar – add a new subscription */
function addSubscription(rssUrl, title, imageUrl) {
  const subs = getSubscriptions();
  if (subs[rssUrl]) return { success: false, message: 'כבר מנוי לפודקאסט זה' };
  subs[rssUrl] = {
    title: title || rssUrl,
    imageUrl: imageUrl || '',
    subscribeDate: Date.now()
  };
  saveSubscriptions(subs);
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
  const subs = getSubscriptions();
  delete subs[rssUrl];
  saveSubscriptions(subs);
  return { success: true };
}

// ============================================================
// DOWNLOADED URL TRACKING
// ============================================================

function getDownloadedSet() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_DOWNLOADED);
  return raw ? new Set(JSON.parse(raw)) : new Set();
}

function saveDownloadedSet(set) {
  // Keep at most 10,000 entries to stay within the 500KB property limit
  let arr = Array.from(set);
  if (arr.length > 10000) arr = arr.slice(arr.length - 10000);
  PropertiesService.getScriptProperties().setProperty(PROP_DOWNLOADED, JSON.stringify(arr));
}

function markDownloaded(url) {
  const set = getDownloadedSet();
  set.add(url);
  saveDownloadedSet(set);
}

function isDownloaded(url) {
  return getDownloadedSet().has(url);
}

function unmarkDownloaded(url) {
  const set = getDownloadedSet();
  if (!set.delete(url)) return;
  saveDownloadedSet(set);
}

/**
 * Returns true if an audio file for this episode still exists in the podcast folder
 * (single file or first part of a chunked download).
 */
function episodeAudioFilesExistInDrive(podcastTitle, episodeTitle, pubDate) {
  try {
    const folder = getPodcastFolder(podcastTitle || 'כללי');
    const d = pubDate instanceof Date ? pubDate : new Date(pubDate || Date.now());
    const singleName = buildFileName(episodeTitle, d);
    if (folder.getFilesByName(singleName).hasNext()) return true;
    const partName = buildFileName(episodeTitle, d, 1);
    return folder.getFilesByName(partName).hasNext();
  } catch (_) {
    return true;
  }
}

/** If the episode URL is marked downloaded but files were removed from Drive, clear the flag. */
function syncDownloadedFlagWithDrive(url, podcastTitle, episodeTitle, pubDate) {
  if (!isDownloaded(url)) return;
  const d = pubDate instanceof Date ? pubDate : (pubDate ? new Date(pubDate) : new Date());
  if (isNaN(d.getTime())) return;
  if (!episodeAudioFilesExistInDrive(podcastTitle, episodeTitle, d)) {
    unmarkDownloaded(url);
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
function downloadEpisodeToFolder(episodeUrl, episodeTitle, pubDate, folder, description) {
  const contentLength = fetchContentLength(episodeUrl);

  if (contentLength !== null && contentLength <= CHUNK_SIZE) {
    const fileName = buildFileName(episodeTitle, pubDate);
    return [downloadDirect(episodeUrl, fileName, folder, description)];
  }

  if (contentLength !== null && contentLength > CHUNK_SIZE) {
    return downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, contentLength);
  }

  // Unknown size: prefer chunked to avoid UrlFetch's 50MB direct-response limit.
  return downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, null);
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

function ensureFullResponseBytes(resp, context) {
  const headers = resp.getHeaders() || {};
  const bytes = resp.getContent();
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

  const normalized = bytes.slice();
  normalized[xingOffset] = 0;
  normalized[xingOffset + 1] = 0;
  normalized[xingOffset + 2] = 0;
  normalized[xingOffset + 3] = 0;
  return normalized;
}

function fetchContentLength(url) {
  try {
    const headResp = UrlFetchApp.fetch(url, {
      method: 'head',
      followRedirects: true,
      muteHttpExceptions: true
    });
    const fromHead = parseContentLength(headResp.getHeaders());
    if (fromHead !== null) return fromHead;
  } catch (_) { }

  try {
    const probeResp = UrlFetchApp.fetch(url, {
      headers: { Range: 'bytes=0-0' },
      followRedirects: true,
      muteHttpExceptions: true
    });
    const headers = probeResp.getHeaders() || {};
    const fromRange = parseTotalSizeFromContentRange(headers);
    if (fromRange !== null) return fromRange;
    return parseContentLength(headers);
  } catch (_) {
    return null;
  }
}

function downloadDirect(url, fileName, folder, description) {
  const resp = UrlFetchApp.fetch(url, { followRedirects: true, muteHttpExceptions: true });
  if (resp.getResponseCode() >= 400) {
    throw new Error(`HTTP ${resp.getResponseCode()} בעת הורדת הפרק`);
  }
  const bytes = ensureFullResponseBytes(resp, 'הורדה ישירה נכשלה');
  const blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
  const file = folder.createFile(blob);
  if (description) file.setDescription(description);
  return {
    fileId: file.getId(),
    fileName,
    driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
  };
}

function downloadChunked(episodeUrl, episodeTitle, pubDate, folder, description, totalSize) {
  const results = [];
  let offset = 0;
  let part = 1;

  while (true) {
    const rangeEnd = totalSize
      ? Math.min(offset + CHUNK_SIZE - 1, totalSize - 1)
      : offset + CHUNK_SIZE - 1;

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

    // Server returned 200 instead of 206 → doesn't support Range
    if (code === 200) {
      if (part === 1) {
        // We got the whole file in one shot – save it
        const fileName = buildFileName(episodeTitle, pubDate);
        const bytes = ensureFullResponseBytes(resp, 'השרת לא תמך ב-Range והחזיר תגובה חלקית');
        const blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
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

    let bytes = resp.getContent();
    if (part === 1) {
      bytes = normalizeFirstChunkDurationMetadata(bytes);
    }
    const fileName = buildFileName(episodeTitle, pubDate, part);
    const blob = Utilities.newBlob(bytes, 'audio/mpeg', fileName);
    const file = folder.createFile(blob);
    if (description) file.setDescription(`${description ? description + ' ' : ''}(חלק ${part})`);

    results.push({
      fileId: file.getId(),
      fileName,
      driveUrl: `https://drive.google.com/file/d/${file.getId()}/view`
    });

    offset += bytes.length;

    // End conditions
    if (totalSize && offset >= totalSize) break;
    if (!totalSize && bytes.length < CHUNK_SIZE) break; // server returned less → EOF

    part++;
  }

  return results;
}

// ============================================================
// RSS PARSING
// ============================================================

/**
 * Parses an RSS feed and returns { title, imageUrl, episodes[] }
 * episodes: { title, date, description, url }
 */
function parseRSS(xmlUrl) {
  const resp = UrlFetchApp.fetch(xmlUrl, { followRedirects: true, muteHttpExceptions: true });
  if (resp.getResponseCode() >= 400) {
    throw new Error(`לא ניתן לטעון RSS: HTTP ${resp.getResponseCode()}`);
  }

  const feed = resp.getContentText();
  const doc = XmlService.parse(feed);
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

  const episodes = channel.getChildren('item').map(item => {
    const encEl = item.getChild('enclosure');
    const url = encEl?.getAttribute('url')?.getValue() || '';
    if (!url) return null;

    let description = '';
    try {
      const descEl = item.getChild('description');
      description = descEl ? descEl.getValue() : '';
      description = description.replace(/<[^>]*>/g, '').trim().slice(0, 800);
    } catch (_) { /* ignore */ }

    return {
      title: (item.getChildText('title') || 'ללא שם').trim(),
      date: item.getChildText('pubDate') || '',
      description,
      url
    };
  }).filter(Boolean);

  return { title: podcastTitle, imageUrl, episodes };
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
  try {
    if (!episodeData || !episodeData.url) {
      return { success: false, error: 'נתוני הפרק חסרים' };
    }

    const pubDate = episodeData.date ? new Date(episodeData.date) : new Date();
    syncDownloadedFlagWithDrive(
      episodeData.url,
      episodeData.podcastTitle || 'כללי',
      episodeData.title || 'פרק',
      pubDate
    );

    if (isDownloaded(episodeData.url)) {
      return { success: false, alreadyDownloaded: true, error: 'הפרק כבר הורד בעבר' };
    }

    const folder = getPodcastFolder(episodeData.podcastTitle || 'כללי');
    const description = episodeData.description || '';

    const results = downloadEpisodeToFolder(
      episodeData.url,
      episodeData.title || 'פרק',
      pubDate,
      folder,
      description
    );

    markDownloaded(episodeData.url);
    const link = results.map(r => r.driveUrl).join('\n');
    writeLog(episodeData.podcastTitle || '', episodeData.title || '', 'הורד ידנית', '', link);

    return { success: true, files: results };
  } catch (e) {
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
    const doc = XmlService.parse(opmlText);
    const root = doc.getRootElement();
    const body = root.getChild('body');
    if (!body) return { success: false, error: 'קובץ OPML לא תקין – חסר אלמנט body' };

    const feeds = [];
    collectFeedsFromOutlines(body, feeds);

    if (feeds.length === 0) {
      return { success: false, error: 'לא נמצאו feeds בקובץ ה-OPML' };
    }

    const subs = getSubscriptions();
    let added = 0, skipped = 0;

    feeds.forEach(feed => {
      if (!subs[feed.url]) {
        subs[feed.url] = {
          title: feed.title || feed.url,
          imageUrl: '',
          subscribeDate: Date.now()
        };
        added++;
      } else {
        skipped++;
      }
    });

    saveSubscriptions(subs);
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

  // 1. Remove any one-time trigger that scheduled this run
  deleteOneTimeTrigger();

  // 2. Load resume state (if rescheduled)
  let resumeState = null;
  const resumeRaw = props.getProperty(PROP_RESUME);
  if (resumeRaw) {
    try { resumeState = JSON.parse(resumeRaw); } catch (_) { }
  }

  const subs = getSubscriptions();
  const subEntries = Object.entries(subs);
  if (subEntries.length === 0) return;

  const startPi = resumeState ? (resumeState.podcastIndex || 0) : 0;
  const startEi = resumeState ? (resumeState.episodeIndex || 0) : 0;

  let driveFull = false;

  for (let pi = startPi; pi < subEntries.length; pi++) {
    if (driveFull) break;

    const [rssUrl, subData] = subEntries[pi];
    const startEi_ = (pi === startPi) ? startEi : 0;

    // Fetch RSS
    let episodes = [];
    try {
      const parsed = parseRSS(rssUrl);
      // Update cached title if podcast renamed itself
      if (parsed.title && parsed.title !== subData.title) {
        subs[rssUrl].title = parsed.title;
      }
      // Only download episodes published after subscription date
      episodes = parsed.episodes.filter(ep => {
        if (!ep.date) return false;
        const ts = new Date(ep.date).getTime();
        return !isNaN(ts) && ts > (subData.subscribeDate || 0);
      });
    } catch (e) {
      writeLog(subData.title, '—', 'שגיאת RSS', e.message);
      continue;
    }

    for (let ei = startEi_; ei < episodes.length; ei++) {
      // ── Time check ──────────────────────────────────────────
      if (Date.now() - startTime > 5.5 * 60 * 1000) {
        props.setProperty(PROP_RESUME, JSON.stringify({ podcastIndex: pi, episodeIndex: ei }));
        const trig = ScriptApp.newTrigger('podcastManager').timeBased().after(30 * 1000).create();
        props.setProperty(PROP_ONE_TIME_TRIG, trig.getUniqueId());
        // Do NOT write lastRunTime – run is incomplete
        return;
      }

      const ep = episodes[ei];

      const folderTitle = subs[rssUrl].title || subData.title;
      const pubDate = ep.date ? new Date(ep.date) : new Date();
      syncDownloadedFlagWithDrive(ep.url, folderTitle, ep.title, pubDate);
      if (isDownloaded(ep.url)) continue;

      // ── Download ─────────────────────────────────────────────
      try {
        const folder = getPodcastFolder(folderTitle);
        const results = downloadEpisodeToFolder(ep.url, ep.title, pubDate, folder, ep.description);
        markDownloaded(ep.url);
        const link = results.map(r => r.driveUrl).join('\n');
        writeLog(subs[rssUrl].title, ep.title, 'הורד אוטומטית', '', link);
      } catch (e) {
        const msg = e.message || '';
        if (msg.toLowerCase().includes('storage') || msg.toLowerCase().includes('quota')) {
          writeLog(subData.title, ep.title, 'שגיאה', 'Drive מלא – הורדה נכשלה');
          driveFull = true;
          break;
        }
        if (msg.includes('Range requests') || msg.includes('מגבלת UrlFetch')) {
          writeLog(subData.title, ep.title, 'דילוג', 'לא ניתן להוריד – הקובץ גדול מדי והשרת אינו תומך בחלוקה לחלקים (Range)');
          continue;
        }
        writeLog(subData.title, ep.title, 'שגיאה', msg);
      }
    }
  }

  // 3. Save updated subscription metadata (e.g. refreshed titles)
  saveSubscriptions(subs);

  // 4. Run completed (or drive full) – write timestamp and clear resume state
  props.setProperty(PROP_LAST_RUN, String(Date.now()));
  props.deleteProperty(PROP_RESUME);
}
