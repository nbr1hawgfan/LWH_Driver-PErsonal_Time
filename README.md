# LWH Time Off Requests

A standalone PWA for drivers to request **unpaid time off (UTO)** when they have no PTO balance. The front end runs on GitHub Pages and the backend is Google Apps Script with a Google Sheet.

## What it does

**Drivers** (Request / My Requests tabs)
- Pick their name from a dropdown. There's no sign-in, and the app remembers the last name picked on that phone.
- Request full day(s) or a partial day with times. A reason category and a written reason are required.
- See the status of every request and the manager's notes, and cancel pending or approved requests that haven't happened yet.

**Managers** (Manager tab, PIN sign-in, each manager has their own PIN)
- **Pending**: approve or deny with an optional note. Each card shows the driver's occurrences this year and in the last 90 days, and warns if other drivers are already approved off on those dates.
- **Upcoming**: who's out, day by day, for the next 30 days.
- **Drivers**: per-driver occurrences, days, partial hours, rolling 90-day count, and denials. The table is sortable and filterable by year. Tap a driver to see their full history. Managers can add or edit drivers here.
- **All**: searchable list of every request, CSV export, and revoke/cancel.

**Emails** (sent by GAS from the account that deploys it)
| Event | Who gets it |
|---|---|
| New request | Both managers |
| Approved | Both managers **with `time-off.ics` invite attached**, plus the driver if an email is on file |
| Denied | Both managers, plus the driver if an email is on file |
| Approved request cancelled | Both managers **with an .ics cancellation**, which removes the event from Outlook |
| Daily 7 AM (optional) | Both managers, if any request has been pending longer than 24 hrs |

The calendar event is marked **Free / all-day**, so it shows who's out without blocking the managers' own availability.

---

## Setup (about 15 minutes)

### 1. Google Sheet + Apps Script
1. Create a new Google Sheet named **LWH Time Off Requests**.
2. Go to **Extensions → Apps Script**.
3. Replace `Code.gs` with `gas/Code.gs` from this zip.
4. Open **Project Settings**, check **Show "appsscript.json"**, and replace its contents with `gas/appsscript.json`.
5. Select **`setup`** in the function dropdown and click **Run**. Authorize when prompted. This creates the tabs: Requests, Drivers, Managers, Config, Log.
6. Optional: run **`installReminderTrigger`** once to turn on the daily pending reminder.

### 2. Fill in the Sheet
- **Managers** tab: C. Morland and D. Dixon are pre-filled with placeholder PINs **1111 / 2222**. **Change these now.** Fix the names if needed.
- **Drivers** tab: add each driver's Name (exactly as it should show in the dropdown), Email (optional), and Active (TRUE). Delete the sample row. Unchecking Active hides a driver from the dropdown but keeps their history. Drivers can also be added or renamed from the Manager tab, and renaming there carries their history along.
- **Config** tab: set `APP_URL` to your GitHub Pages URL after step 4.

### 3. Deploy the API
1. **Deploy → New deployment → Web app**
2. Execute as: **Me**. Who has access: **Anyone**.
3. Copy the **/exec** URL.
4. When you change Code.gs later, use **Deploy → Manage deployments → Edit → New version**. That keeps the same URL.

### 4. GitHub Pages
1. Create a repo, for example `nbr1hawgfan/LWH_Time_Off_Requests`.
2. Paste the /exec URL into **`config.js`**.
3. Upload everything **except the `gas/` folder**.
4. Go to **Settings → Pages → Deploy from branch → main / root**.
5. Put the Pages URL into the Config tab as `APP_URL`.
6. When you push changes later, bump `VERSION` in `sw.js` so phones pick them up.

Managers can bookmark `…/LWH_Time_Off_Requests/#manager` to open straight to the PIN pad.

---

## Notes

- **Outlook invite**: the .ics comes as an attachment. Opening it in Outlook shows the event with Accept or Add to Calendar. Fully automatic calendar inserts would need Microsoft Graph access through IT, which is a possible phase 2.
- **Who sends the email**: emails come from the Google account that deployed the script. A shared ops account is a good choice. Consumer Gmail can send about 100 emails a day, Workspace about 1,500.
- **Occurrence** means one approved request. Denied and cancelled requests are counted separately and don't count as occurrences.
- **Security**: only the manager PINs protect anything. Each PIN locks after 5 bad tries for 15 minutes, and manager sessions expire after 8 hours. The driver side is open by design, so anyone with the link could submit for, or view the requests of, any name in the list. Managers review every request, so a bogus one just gets denied.
- Two drivers with the same name need something to tell them apart in the Name column, like a last-name initial or middle initial. The app won't save duplicate names.
- Dates are stored as plain text (`yyyy-MM-dd`) in the Sheet so they never shift time zones. The time zone is America/Chicago.
- Each request is limited to 30 days. A driver can't submit two overlapping pending or approved requests.
