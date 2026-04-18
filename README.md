# 🎙 Podcast manager for Google Drive & Sheets

## English

### What this project does
This Google Apps Script project binds to a **Google Sheet** and provides a **sidebar** to subscribe to podcasts (iTunes search, **RSS URL**, or **OPML**), browse episodes, download MP3s to **Google Drive** under a folder named `הסכתים`, and optionally run an **automatic download** every 6 hours. A **Log** sheet records activity and includes **links** to downloaded files.

### Project files
| File | Role |
|------|------|
| `Code.gs` | Server-side logic (RSS, Drive, subscriptions, triggers) |
| `Sidebar.html` | Sidebar UI (Hebrew-facing strings) |
| `appsscript.json` | Manifest (scopes, runtime V8, timezone) |
| `CHANGES.md` | Change log (English) |

### Installation

#### Option A – clasp (recommended for developers)
1. Install [clasp](https://github.com/google/clasp): `npm install -g @google/clasp`
2. Run `clasp login`
3. From this folder: `clasp create --title "Your title" --type sheets` (creates a new Sheet + bound script), then `clasp push`
4. Open the Sheet, then **Extensions → Apps Script**, run **`onOpen`** once and complete **authorization**
5. Refresh the Sheet; use the **🎙 הסכתים** menu → **פתח מנהל הסכתים**

#### Option B – Manual copy in the browser
1. Create a new **Google Sheet**
2. **Extensions → Apps Script**
3. Replace default `Code.gs` with this repo’s `Code.gs`
4. Add an **HTML** file named **`Sidebar`** (no extension) with the contents of `Sidebar.html`
5. In project settings, enable **Show app manifest** and replace `appsscript.json` as needed
6. Save, run **`onOpen`**, approve permissions, refresh the Sheet, open the sidebar from the menu

### Using the sidebar
- **🔍** – Search podcasts (iTunes API), subscribe from results  
- **🔗** – Add a podcast by **RSS feed URL** (feed is validated before saving)  
- **📥 / 📤** – Import / export subscriptions as **OPML**  
- After subscribing from search, use **Back** to refresh the list (or add via RSS / OPML, which refreshes automatically)

### Automatic downloads (optional)
Menu **🎙 הסכתים** → **התקן טריגר אוטומטי (כל 6 שעות)**. New episodes **after** the subscription date are downloaded. To remove the schedule, use **הסר טריגר אוטומטי**.

### Storage layout
| Location | Contents |
|----------|----------|
| Script **Properties** | Subscriptions, downloaded episode URLs, resume state for long runs |
| Drive **`הסכתים/`** | Root folder |
| Drive **`הסכתים/<podcast name>/`** | MP3 files |
| Sheet **`Log`** | Download/error log; successful rows include a **קישור** column with Drive URLs |

### Technical notes
- **Filenames:** `YYMMDD episode title.mp3`. Large files (about 40MB and above) may be split: `YYMMDD title (חלק 001).mp3`, etc.
- **6-minute limit:** Long automatic runs save progress and reschedule after ~30 seconds; `lastRunTime` is written only when a full run finishes.
- **“Already downloaded” vs Drive:** If you **delete** the file from Drive, the script can detect missing files (by expected name) and **allow download again**.
- **HtmlService / `google.script.run`:** If you see **PERMISSION_DENIED** (“error reading from storage”), try a **single Google account** in the browser (e.g. **Incognito** with one account) — a common cause is multiple logged-in Google accounts.

---

<div dir="rtl">

<h2>מדריך בעברית: מה הכלי נותן ואיך מתקינים</h2>

<h3>מנויים, הורדת פרקים לדרייב, ולוג עם קישורים לקבצים</h3>
<p>פרויקט <strong>Google Apps Script</strong> המחובר ל־<strong>Google Sheet</strong>, עם <strong>סרגל צד</strong> לניהול פודקאסטים: חיפוש (iTunes), <strong>הזנת כתובת RSS</strong>, או <strong>ייבוא OPML</strong>, צפייה בפרקים, הורדת MP3 ל־<strong>Google Drive</strong> לתיקייה בשם <code>הסכתים</code>, ואפשרות להורדה אוטומטית כל <strong>6 שעות</strong>. גיליון <strong>Log</strong> מתעד פעולות וכולל <strong>קישורים</strong> לקבצים שהורדו.</p>

<h3>רשימת הקבצים ומה כל אחד אחראי עליו</h3>
<table>
  <thead>
    <tr>
      <th>קובץ</th>
      <th>תפקיד</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>Code.gs</code></td>
      <td>לוגיקת שרת (RSS, דרייב, מנויים, טריגרים)</td>
    </tr>
    <tr>
      <td><code>Sidebar.html</code></td>
      <td>ממשק סרגל הצד (טקסטים בעברית)</td>
    </tr>
    <tr>
      <td><code>appsscript.json</code></td>
      <td>מניפסט (הרשאות, V8, אזור זמן)</td>
    </tr>
    <tr>
      <td><code>CHANGES.md</code></td>
      <td>יומן שינויים (באנגלית)</td>
    </tr>
  </tbody>
</table>

<h3>חיבור הפרויקט לגיליון Google Sheets</h3>

<h4>דרך clasp: יצירת גיליון ודחיפת הקוד משורת הפקודה</h4>
<ol>
  <li>התקנת <a href="https://github.com/google/clasp">clasp</a>: <code>npm install -g @google/clasp</code></li>
  <li><code>clasp login</code></li>
  <li>מתיקיית הפרויקט: <code>clasp create --title "שם לדוגמה" --type sheets</code> ואז <code>clasp push</code></li>
  <li>פתיחת הגיליון → <strong>Extensions → Apps Script</strong>, הרצת <strong><code>onOpen</code></strong> פעם אחת ואישור <strong>הרשאות</strong></li>
  <li>רענון הגיליון; בתפריט <strong>🎙 הסכתים</strong> → <strong>פתח מנהל הסכתים</strong></li>
</ol>

<h4>בלי clasp: העתקת קבצים ידנית ב־Apps Script בדפדפן</h4>
<ol>
  <li><strong>חדש → Google Sheets</strong></li>
  <li><strong>Extensions → Apps Script</strong></li>
  <li>להחליף את <code>Code.gs</code> בתוכן הקובץ מהריפו</li>
  <li><strong>קובץ חדש → HTML</strong>, שם <strong><code>Sidebar</code></strong> (בלי סיומת), להדביק את <code>Sidebar.html</code></li>
  <li>בהגדרות הפרויקט: <strong>Show app manifest</strong> ולעדכן את <code>appsscript.json</code> לפי הצורך</li>
  <li>שמירה, הרצת <strong><code>onOpen</code></strong>, אישור הרשאות, רענון הגיליון, פתיחת הסרגל מהתפריט</li>
</ol>

<h3>חיפוש ב־iTunes, הזנת RSS, OPML ופעולות בסרגל הצד</h3>
<ul>
  <li><strong>🔍</strong> – חיפוש פודקאסטים והרשמה מתוצאות</li>
  <li><strong>🔗</strong> – הוספת פודקאסט לפי <strong>כתובת RSS</strong> (הפיד נבדק לפני השמירה)</li>
  <li><strong>📥 / 📤</strong> – ייבוא וייצוא <strong>OPML</strong></li>
  <li>אחרי הרשמה מחיפוש: <strong>חזרה</strong> ממסך החיפוש מרעננת את רשימת המנויים מהשרת</li>
</ul>

<h3>הפעלת הורדה אוטומטית כל 6 שעות (אופציונלי)</h3>
<p>בתפריט <strong>🎙 הסכתים</strong> → <strong>התקן טריגר אוטומטי (כל 6 שעות)</strong>. יורדים פרקים שפורסמו <strong>אחרי</strong> תאריך המנוי. להסרה: <strong>הסר טריגר אוטומטי</strong>.</p>

<h3>איפה נשמרים המנויים, תיקיות ה־MP3 והלוג</h3>
<table>
  <thead>
    <tr>
      <th>מיקום</th>
      <th>תיאור</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>מאפייני הסקריפט</td>
      <td>מנויים, כתובות פרקים שהורדו, מצב המשך ריצה</td>
    </tr>
    <tr>
      <td>דרייב / <code>הסכתים/</code></td>
      <td>תיקיית שורש</td>
    </tr>
    <tr>
      <td>דרייב / <code>הסכתים/&lt;שם פודקאסט&gt;/</code></td>
      <td>קבצי MP3</td>
    </tr>
    <tr>
      <td>גיליון <code>Log</code></td>
      <td>לוג הורדות ושגיאות; בעמודה <strong>קישור</strong> קישורים לקבצים בדרייב</td>
    </tr>
  </tbody>
</table>

<h3>מגבלות זמן ריצה, שמות קבצים ופתרון תקלות נפוצות</h3>
<ul>
  <li><strong>שמות קבצים:</strong> <code>YYMMDD שם הפרק.mp3</code>. קבצים גדולים מחולקים: <code>YYMMDD שם (חלק 001).mp3</code> וכו'.</li>
  <li><strong>מגבלת 6 דקות:</strong> ריצה ארוכה שומרת מצב ומתזמנת המשך בערך אחרי 30 שניות. <code>lastRunTime</code> נכתב רק כשהריצה מסתיימת בהצלחה.</li>
  <li><strong>מחיקה בדרייב:</strong> אם מחקת קובץ מהדרייב, הסקריפט יכול לזהות שאין קובץ צפוי ולאפשר <strong>הורדה מחדש</strong>.</li>
  <li><strong>שגיאת PERMISSION_DENIED בסרגל:</strong> נסה <strong>חשבון גוגל יחיד</strong> בדפדפן (למשל <strong>חלון אנונימי</strong>) — לעיתים הבעיה נגרמת מכמה חשבונות מחוברים בו־זמנית.</li>
</ul>

</div>
