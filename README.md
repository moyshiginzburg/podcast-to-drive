# 🎙️ Podcast to Drive
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://opensource.org/licenses/AGPL-3.0)
[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://developers.google.com/apps-script)
[![Google Drive](https://img.shields.io/badge/Google%20Drive-4285F4?style=flat&logo=googledrive&logoColor=white)](https://drive.google.com/)

[**🇮🇱 לקריאת המסמך בעברית, גללו למטה (Hebrew Version Below)**](#-podcast-to-drive---hebrew)

**Podcast to Drive** is a smart, private, and ad-free podcast manager built entirely on Google Apps Script. It allows you to subscribe to your favorite podcasts and automatically downloads new episodes directly to your personal Google Drive, organizing them neatly so you can listen anywhere without relying on third-party apps.

---

## ✨ Features
- **Direct to Drive:** Downloads MP3 files straight to a dedicated `הסכתים` folder in your Google Drive.
- **Privacy First:** Your data never leaves your Google account. No external servers, no tracking, no sign-ups.
- **Smart Background Worker:** Automatically checks for new episodes every 6 hours. Background downloads are queued and processed asynchronously, bypassing execution time limits and memory constraints.
- **Large File Support:** Seamlessly handles large podcast episodes using chunked downloads (`Range` requests) and mitigates Apps Script memory limitations.
- **Simple UI:** Manage subscriptions (via iTunes search, RSS, or OPML) through a clean, Hebrew-localized Sidebar inside Google Sheets.
- **Detailed Logging:** Keeps a rich-text log of all downloaded episodes and their direct Drive links.

---

## 🚀 How It Works

The system operates within a Google Sheet that acts as your database and control panel.
1. **Subscriptions (`מנויים`):** You add podcasts via the UI. The script saves the RSS feed and metadata here.
2. **Download Engine (`Code.gs`):** 
   - A time-based trigger runs `podcastManager` every 6 hours.
   - It parses your active RSS feeds and identifies episodes published after your subscription date.
   - Pending episodes are pushed to a hidden queue (`תור הורדות`).
   - A separate background worker (`downloadWorker`) processes this queue one by one, downloading files directly or in chunks if they are large, ensuring the script never times out.
3. **Storage (`הסכתים` folder):** Audio files are saved in `Google Drive/הסכתים/<Podcast Name>/`.
4. **Tracking (`הורדות` & `Log`):** Successfully downloaded episode URLs are saved in the `הורדות` sheet to prevent duplicates. A detailed record with clickable links is written to the `Log` sheet.

---

## 🛠️ Installation

### Option 1: 1-Click Installation (Recommended for Users)
The easiest way to get started is by copying the pre-configured template:
1. Go to the **[1-Click Installation Page](https://moyshiginzburg.github.io/podcast-to-drive/)** (Hebrew).
2. Click the **"צור עותק של המערכת"** button to clone the Google Sheet to your Drive.
3. Open the copied Sheet, go to the **"התחלה"** (Start) tab, and click the green button to authorize the script.
4. Once authorized, a new menu **`🎙 הסכתים`** will appear at the top. Click it to open the manager!

### Option 2: Local Deployment via Clasp (For Developers)
If you want to deploy the code yourself or contribute:
1. Install [clasp](https://github.com/google/clasp): 
   ```bash
   npm install -g @google/clasp
   ```
2. Login to your Google account:
   ```bash
   clasp login
   ```
3. Clone this repository and navigate to the folder.
4. Create a new Apps Script project bound to a Google Sheet:
   ```bash
   clasp create --title "Podcast Manager" --type sheets
   ```
5. Push the code to your project:
   ```bash
   clasp push
   ```
6. Open your Google Sheet, navigate to **Extensions → Apps Script**, run the `onOpen` function once to complete authorization, and refresh the page.

---

## 📜 Storage Layout

| Location | Contents |
|----------|----------|
| Sheet **`מנויים`** | Subscriptions: `כתובת RSS`, `שם`, `תמונה`, `תאריך הרשמה`, `סטטוס` (`פעיל` / `בוטל`) |
| Sheet **`הורדות`** | Downloaded episode URLs (`כתובת`) |
| Sheet **`Log`** | Columns: `תאריך`, `פודקאסט`, `פרק`, `סטטוס`, `הערה`, `קישור` |
| Sheet **`תור הורדות`** | *(Hidden)* Internal queue for the background downloader |
| Script **Properties** | `lastRunTime`, `resumeState`, `downloadWorkerTrigId` |
| Drive **`הסכתים/`** | Root folder for audio files |
| Drive **`הסכתים/<podcast name>/`** | MP3 files per podcast |

## ⚠️ Common Issues & Troubleshooting

- **`PERMISSION_DENIED` Error:** If you see an error saying "PERMISSION_DENIED" when opening or using the sidebar, this is a known Google Apps Script issue caused by being logged into **multiple Google accounts** in the same browser session.
  - *Solution:* Open the spreadsheet in an **Incognito/Private window**, or use a dedicated browser profile where only one Google account is logged in.
- **Mobile Support:** The podcast manager UI (Custom Menu and Sidebar) can **only be accessed from a computer browser**. The Google Sheets mobile app does not support custom menus or sidebars. However, the automatic background downloads will continue to work normally regardless of the device you use.

## 📄 License
This project is licensed under the [AGPL-3.0 License](LICENSE).

---
<br>

<div dir="rtl">

# 🎙️ Podcast to Drive - בעברית

המערכת **Podcast to Drive** (פודקאסט לדרייב) היא מנהל פודקאסטים חכם, פרטי ונקי מפרסומות, הבנוי כולו על גבי סביבת Google Apps Script. היא מאפשרת לכם להירשם לפודקאסטים האהובים עליכם ומורידה אוטומטית פרקים חדשים ישירות ל-Google Drive האישי שלכם, כך שתוכלו להאזין להם מכל מקום בלי להיות תלויים באפליקציות צד-שלישי.

## ✨ תכונות מרכזיות
- **ישירות לדרייב:** הורדת קבצי MP3 ישירות לתיקיית `הסכתים` ב-Google Drive שלכם.
- **פרטיות מעל הכל:** המידע שלכם נשאר רק אצלכם. המערכת פועלת מתוך חשבון הגוגל שלכם, ללא שרתים חיצוניים או הרשמות.
- **טייס אוטומטי חכם:** בדיקה אוטומטית של פרקים חדשים כל 6 שעות. המערכת מנהלת תור הורדות ברקע כדי לעקוף את מגבלות זמן הריצה והזיכרון של גוגל.
- **תמיכה בקבצים גדולים:** טיפול חכם בפרקים ארוכים באמצעות הורדה בחלקים (`Chunked Downloads`), מה שמונע קריסות (שגיאות זיכרון) ומבטיח הורדה חלקה של כל פרק.
- **ממשק משתמש פשוט:** ניהול מנויים (דרך חיפוש ב-iTunes, הזנת כתובת RSS, או ייבוא OPML) דרך חלונית צד נקייה וידידותית בעברית מתוך Google Sheets.
- **יומן פעילות מפורט:** מעקב מלא אחר כל ההורדות בגיליון ה-`Log`, כולל קישורים ישירים ונוחים לקבצים בדרייב.

## 🚀 איך זה עובד?

המערכת פועלת מתוך גיליון Google Sheets שמשמש כמסד הנתונים ולוח הבקרה שלכם:
1. **מנויים (`מנויים`):** המקום שבו נשמרים הפודקאסטים שהוספתם במערכת.
2. **מנוע ההורדות (`Code.gs`):** 
   - טריגר אוטומטי פועל כל 6 שעות ובודק אם יצאו פרקים חדשים מאז תאריך ההרשמה שלכם לפודקאסט.
   - פרקים שממתינים להורדה נכנסים לגיליון תור נסתר (`תור הורדות`).
   - "פועל רקע" (Worker) נפרד עובר על התור ומוריד את הפרקים אחד-אחד אל הדרייב שלכם ביעילות וללא חריגה מזמני הריצה המותרים של גוגל.
3. **אחסון (תיקיית `הסכתים`):** קבצי השמע נשמרים תחת נתיב מסודר בדרייב: `הסכתים/<שם הפודקאסט>/`.
4. **מעקב (`הורדות` ו-`Log`):** המערכת רושמת כל פרק שירד כדי לא להוריד אותו פעמיים, ומתעדת את התהליך (וההצלחה) ביומן הפעילות.

## 🛠️ התקנה

### אפשרות 1: התקנה בקליק (הדרך המומלצת למשתמשים)
הדרך הקלה והמהירה ביותר להתחיל היא על ידי יצירת עותק של התבנית המוכנה מראש:
1. היכנסו אל **[עמוד ההתקנה של הפרויקט](https://moyshiginzburg.github.io/podcast-to-drive/)**.
2. לחצו על הכפתור **"צור עותק של המערכת"** כדי לשכפל את הגיליון לחשבון שלכם.
3. פתחו את הגיליון שנוצר, היכנסו ללשונית **"התחלה"**, ולחצו על הכפתור הירוק כדי לאשר למערכת את הרשאות הגישה בפעם הראשונה.
4. לאחר אישור ההרשאות, יופיע בתפריט העליון של הגיליון כפתור חדש בשם **`🎙 הסכתים`**. לחצו עליו, בחרו ב"פתח מנהל הסכתים", ותתחילו לארגן את הפודקאסטים שלכם!

### אפשרות 2: פריסה מקומית דרך Clasp (למפתחים)
אם תרצו לעבוד על הקוד בעצמכם או לתרום לפרויקט:
1. התקינו את סביבת [clasp](https://github.com/google/clasp): 
   ```bash
   npm install -g @google/clasp
   ```
2. התחברו לחשבון הגוגל שלכם דרך הטרמינל:
   ```bash
   clasp login
   ```
3. שכפלו את המאגר הזה למחשב שלכם ונווטו אל התיקייה.
4. צרו פרויקט Apps Script חדש שמחובר לגיליון חדש בדרייב:
   ```bash
   clasp create --title "Podcast Manager" --type sheets
   ```
5. דחפו את הקוד שלכם לפרויקט:
   ```bash
   clasp push
   ```
6. פתחו את גיליון ה-Google Sheet שנוצר, גשו בתפריט ל-**Extensions → Apps Script**, הריצו את הפונקציה `onOpen` פעם אחת על מנת לאשר הרשאות, ורעננו את דף הגיליון.

## 📜 מבנה האחסון

| מיקום | תוכן |
|----------|----------|
| גיליון **`מנויים`** | רשימת המנויים: `כתובת RSS`, `שם`, `תמונה`, `תאריך הרשמה`, `סטטוס` (`פעיל` / `בוטל`) |
| גיליון **`הורדות`** | קישורי הפרקים שכבר ירדו כדי למנוע כפילויות (`כתובת`) |
| גיליון **`Log`** | יומן המערכת: `תאריך`, `פודקאסט`, `פרק`, `סטטוס`, `הערה`, `קישור` ישיר לקובץ |
| גיליון **`תור הורדות`** | *(מוסתר)* תור פנימי המנהל את הורדות הרקע של הפרקים |
| מאפייני סקריפט | משתני מערכת: `lastRunTime`, `resumeState`, `downloadWorkerTrigId` |
| כונן Drive **`הסכתים/`** | התיקייה הראשית שבה נשמרים כל הפודקאסטים |
| כונן Drive **`הסכתים/<שם הפודקאסט>/`** | קבצי ה-MP3 מסודרים לפי פודקאסט |

<a id="faq"></a>
## ⚠️ בעיות נפוצות ופתרון תקלות

- **שגיאת `PERMISSION_DENIED` בחלונית הניהול:** אם נתקלתם בשגיאה בסגנון "אירעה שגיאת שרת... PERMISSION_DENIED", מדובר בבעיה מוכרת של גוגל שמתרחשת כאשר **מספר חשבונות גוגל שונים מחוברים לאותו דפדפן** במקביל.
  - *פתרון:* פתחו את הגיליון ב**חלון גלישה בסתר (Incognito)**, או השתמשו בפרופיל דפדפן (כמו פרופיל כרום) שבו מחובר אך ורק חשבון גוגל אחד.
- **שימוש בטלפון הנייד:** ניהול הפודקאסטים (הוספת מנויים, פתיחת תפריט ההסכתים) **אפשרי ממחשב בלבד**. אפליקציית Google Sheets בטלפון אינה תומכת בתפריטים מותאמים אישית או חלוניות צד. עם זאת, הורדות הרקע האוטומטיות ימשיכו לפעול כרגיל בלי קשר למכשיר שבו אתם משתמשים.

## 📄 רישיון
הפרויקט פועל תחת רישיון קוד פתוח [AGPL-3.0 License](LICENSE).

</div>
