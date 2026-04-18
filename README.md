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

## עברית

### מה הפרויקט עושה
פרויקט **Google Apps Script** המחובר ל־**Google Sheet**, עם **סרגל צד** לניהול פודקאסטים: חיפוש (iTunes), **הזנת כתובת RSS**, או **ייבוא OPML**, צפייה בפרקים, הורדת MP3 ל־**Google Drive** לתיקייה בשם `הסכתים`, ואפשרות להורדה אוטומטית כל **6 שעות**. גיליון **Log** מתעד פעולות וכולל **קישורים** לקבצים שהורדו.

### קבצים בפרויקט
| קובץ | תפקיד |
|------|--------|
| `Code.gs` | לוגיקת שרת (RSS, דרייב, מנויים, טריגרים) |
| `Sidebar.html` | ממשק סרגל הצד (טקסטים בעברית) |
| `appsscript.json` | מניפסט (הרשאות, V8, אזור זמן) |
| `CHANGES.md` | יומן שינויים (באנגלית) |

### התקנה

#### אפשרות א – clasp (מתאים למפתחים)
1. התקנת [clasp](https://github.com/google/clasp): `npm install -g @google/clasp`
2. `clasp login`
3. מתיקיית הפרויקט: `clasp create --title "שם לדוגמה" --type sheets` ואז `clasp push`
4. פתיחת הגיליון → **Extensions → Apps Script**, הרצת **`onOpen`** פעם אחת ואישור **הרשאות**
5. רענון הגיליון; בתפריט **🎙 הסכתים** → **פתח מנהל הסכתים**

#### אפשרות ב – העתקה ידנית בדפדפן
1. **חדש → Google Sheets**
2. **Extensions → Apps Script**
3. להחליף את `Code.gs` בתוכן הקובץ מהריפו
4. **קובץ חדש → HTML**, שם **`Sidebar`** (בלי סיומת), להדביק את `Sidebar.html`
5. בהגדרות הפרויקט: **Show app manifest** ולעדכן את `appsscript.json` לפי הצורך
6. שמירה, הרצת **`onOpen`**, אישור הרשאות, רענון הגיליון, פתיחת הסרגל מהתפריט

### שימוש בסרגל הצד
- **🔍** – חיפוש פודקאסטים והרשמה מתוצאות  
- **🔗** – הוספת פודקאסט לפי **כתובת RSS** (הפיד נבדק לפני השמירה)  
- **📥 / 📤** – ייבוא וייצוא **OPML**  
- אחרי הרשמה מחיפוש: **חזרה** ממסך החיפוש מרעננת את רשימת המנויים מהשרת

### הורדה אוטומטית (אופציונלי)
בתפריט **🎙 הסכתים** → **התקן טריגר אוטומטי (כל 6 שעות)**. יורדים פרקים שפורסמו **אחרי** תאריך המנוי. להסרה: **הסר טריגר אוטומטי**.

### מבנה האחסון
| מיקום | תיאור |
|-------|--------|
| מאפייני הסקריפט | מנויים, כתובות פרקים שהורדו, מצב המשך ריצה |
| דרייב / `הסכתים/` | תיקיית שורש |
| דרייב / `הסכתים/<שם פודקאסט>/` | קבצי MP3 |
| גיליון `Log` | לוג הורדות ושגיאות; בעמודה **קישור** קישורים לקבצים בדרייב |

### הערות טכניות
- **שמות קבצים:** `YYMMDD שם הפרק.mp3`. קבצים גדולים מחולקים: `YYMMDD שם (חלק 001).mp3` וכו'.
- **מגבלת 6 דקות:** ריצה ארוכה שומרת מצב ומתזמנת המשך בערך אחרי 30 שניות. `lastRunTime` נכתב רק כשהריצה מסתיימת בהצלחה.
- **מחיקה בדרייב:** אם מחקת קובץ מהדרייב, הסקריפט יכול לזהות שאין קובץ צפוי ולאפשר **הורדה מחדש**.
- **שגיאת PERMISSION_DENIED בסרגל:** נסה **חשבון גוגל יחיד** בדפדפן (למשל **חלון אנונימי**) — לעיתים הבעיה נגרמת מכמה חשבונות מחוברים בו־זמנית.
