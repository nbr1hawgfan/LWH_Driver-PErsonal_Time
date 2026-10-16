/**
 * LWH Time Off Requests — Google Apps Script JSON API
 * Unpaid time off (UTO) requests for drivers with no PTO balance.
 *
 * Bind this script to a Google Sheet (Extensions > Apps Script),
 * run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone).
 */

const TZ = 'America/Chicago';
const SH = { REQ: 'Requests', DRV: 'Drivers', MGR: 'Managers', CFG: 'Config', LOG: 'Log' };

const HEADERS = {
  Requests: ['ID', 'Submitted', 'DriverName', 'DriverEmail', 'Type', 'StartDate', 'EndDate',
             'StartTime', 'EndTime', 'Days', 'Hours', 'Category', 'Reason', 'Status', 'DecidedBy',
             'DecidedAt', 'ManagerNote', 'Seq', 'CancelledAt', 'CancelledBy'],
  Drivers:  ['Name', 'Email', 'Active'],
  Managers: ['Name', 'Email', 'PIN', 'Active'],
  Config:   ['Key', 'Value', 'Notes'],
  Log:      ['Timestamp', 'Who', 'Action', 'Detail']
};

const CATEGORIES = ['Personal', 'Family', 'Medical', 'Vehicle / Transportation', 'Bereavement', 'Court / Legal', 'Weather', 'Other'];
const TEXT_COLS = ['ID', 'StartDate', 'EndDate', 'StartTime', 'EndTime', 'PIN'];
const MAX_DAYS = 30;
const TOKEN_TTL = 8 * 60 * 60; // 8 hours

/* ============================== SETUP ============================== */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    // Keep dates/times/IDs/PINs as plain text so Sheets doesn't reformat them
    HEADERS[name].forEach((h, i) => {
      if (TEXT_COLS.indexOf(h) > -1) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });

  const mgr = ss.getSheetByName(SH.MGR);
  if (mgr.getLastRow() === 1) {
    mgr.appendRow(['C. Morland', 'cmorland@logistics-warehouse.com', '1111', true]);
    mgr.appendRow(['D. Dixon', 'ddixon@logistics-warehouse.com', '2222', true]);
  }

  const cfg = ss.getSheetByName(SH.CFG);
  if (cfg.getLastRow() === 1) {
    cfg.appendRow(['APP_URL', 'https://YOUR-GITHUB-USER.github.io/LWH_Time_Off_Requests/', 'Link included in emails']);
    cfg.appendRow(['APP_NAME', 'LWH Time Off Requests', 'Shown in email subjects']);
    cfg.appendRow(['REMINDER_HOURS', '24', 'Daily reminder lists pending requests older than this']);
  }

  const drv = ss.getSheetByName(SH.DRV);
  if (drv.getLastRow() === 1) {
    drv.appendRow(['Sample Driver', '', true]);
  }

  log_('system', 'setup', 'Sheets initialized');
  SpreadsheetApp.getUi && SpreadsheetApp.getActive().toast('Setup complete. Change the manager PINs on the Managers tab!', 'LWH Time Off', 10);
}

/** Run once to email managers each weekday morning about stale pending requests. */
function installReminderTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pendingReminder')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pendingReminder').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
}

/* ============================== ROUTER ============================== */

function doGet() {
  return json_({ ok: true, service: 'LWH Time Off Requests API', time: now_() });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handlers = {
      meta: apiMeta_,
      submit: apiSubmit_,
      myRequests: apiMyRequests_,
      driverCancel: apiDriverCancel_,
      mgrLogin: apiMgrLogin_,
      mgrLogout: apiMgrLogout_,
      mgrData: apiMgrData_,
      decide: apiDecide_,
      mgrCancel: apiMgrCancel_,
      saveDriver: apiSaveDriver_
    };
    const fn = handlers[body.action];
    if (!fn) throw new Error('Unknown action');
    return json_(Object.assign({ ok: true }, fn(body)));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ============================== DRIVER API ============================== */

function apiMeta_() {
  const drivers = readTable_(SH.DRV)
    .filter(d => truthy_(d.Active) && String(d.Name).trim())
    .map(d => String(d.Name).trim())
    .sort((x, y) => x.localeCompare(y));
  return { categories: CATEGORIES, maxDays: MAX_DAYS, today: today_(), drivers: drivers };
}

function apiSubmit_(b) {
  const d = authDriver_(b.driver);
  const r = b.request || {};
  const type = r.type === 'Partial' ? 'Partial' : 'Full';

  if (!isDate_(r.startDate)) throw new Error('Start date is required.');
  const endDate = type === 'Partial' ? r.startDate : r.endDate;
  if (!isDate_(endDate)) throw new Error('End date is required.');
  if (endDate < r.startDate) throw new Error('End date cannot be before start date.');
  if (CATEGORIES.indexOf(r.category) < 0) throw new Error('Pick a reason category.');
  const reason = String(r.reason || '').trim();
  if (reason.length < 5) throw new Error('Please explain the reason.');
  if (reason.length > 1000) throw new Error('Reason is too long (1000 characters max).');

  let days = 0, hours = 0, startTime = '', endTime = '';
  if (type === 'Full') {
    days = dayDiff_(r.startDate, endDate) + 1;
    if (days > MAX_DAYS) throw new Error('Requests are limited to ' + MAX_DAYS + ' days. Submit separate requests if needed.');
  } else {
    if (!isTime_(r.startTime) || !isTime_(r.endTime)) throw new Error('Start and end times are required for a partial day.');
    if (r.endTime <= r.startTime) throw new Error('End time must be after start time.');
    startTime = r.startTime; endTime = r.endTime;
    hours = Math.round((mins_(endTime) - mins_(startTime)) / 60 * 100) / 100;
  }

  return withLock_(() => {
    const overlap = readTable_(SH.REQ).find(x =>
      x.DriverName === d.Name &&
      (x.Status === 'Pending' || x.Status === 'Approved') &&
      x.StartDate <= endDate && x.EndDate >= r.startDate);
    if (overlap) throw new Error('You already have a ' + overlap.Status.toLowerCase() + ' request covering those dates (' + overlap.ID + ').');

    const req = {
      ID: newId_(), Submitted: now_(), DriverName: d.Name, DriverEmail: d.Email || '',
      Type: type, StartDate: r.startDate, EndDate: endDate, StartTime: startTime, EndTime: endTime,
      Days: days, Hours: hours, Category: r.category, Reason: reason, Status: 'Pending',
      DecidedBy: '', DecidedAt: '', ManagerNote: '', Seq: 0, CancelledAt: '', CancelledBy: ''
    };
    appendObj_(SH.REQ, req);
    log_(d.Name, 'submit', req.ID);
    notifyManagersNew_(req);
    return { request: publicReq_(req) };
  });
}

function apiMyRequests_(b) {
  const d = authDriver_(b.driver);
  const list = readTable_(SH.REQ)
    .filter(x => x.DriverName === d.Name)
    .map(publicReq_)
    .sort((a, b) => b.submitted.localeCompare(a.submitted));
  return { requests: list };
}

function apiDriverCancel_(b) {
  const d = authDriver_(b.driver);
  return withLock_(() => {
    const req = findReq_(b.id);
    if (req.DriverName !== d.Name) throw new Error('Request not found.');
    if (req.Status !== 'Pending' && req.Status !== 'Approved') throw new Error('This request can no longer be cancelled.');
    if (req.EndDate < today_()) throw new Error('Past requests cannot be cancelled. Contact a manager.');
    const wasApproved = req.Status === 'Approved';
    updateObj_(SH.REQ, req._row, { Status: 'Cancelled', CancelledAt: now_(), CancelledBy: d.Name, Seq: Number(req.Seq || 0) + 1 });
    const fresh = findReq_(b.id);
    log_(d.Name, 'driverCancel', req.ID);
    notifyCancel_(fresh, d.Name, wasApproved);
    return { request: publicReq_(fresh) };
  });
}

/* ============================== MANAGER API ============================== */

function apiMgrLogin_(b) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinfails') || 0);
  if (fails >= 5) throw new Error('Too many attempts. Try again in 15 minutes.');

  const pin = String(b.pin || '').trim();
  const m = readTable_(SH.MGR).find(x => truthy_(x.Active) && String(x.PIN).trim() === pin && pin !== '');
  if (!m) {
    cache.put('pinfails', String(fails + 1), 15 * 60);
    throw new Error('Incorrect PIN.');
  }
  cache.remove('pinfails');
  const token = Utilities.getUuid();
  cache.put('tok_' + token, JSON.stringify({ name: m.Name, email: m.Email }), TOKEN_TTL);
  log_(m.Name, 'mgrLogin', '');
  return { token: token, manager: { name: m.Name, email: m.Email } };
}

function apiMgrLogout_(b) {
  if (b.token) CacheService.getScriptCache().remove('tok_' + b.token);
  return {};
}

function apiMgrData_(b) {
  const m = authMgr_(b.token);
  const requests = readTable_(SH.REQ).map(mgrReq_).sort((a, b) => b.submitted.localeCompare(a.submitted));
  const drivers = readTable_(SH.DRV).filter(d => String(d.Name).trim()).map(d => ({
    name: String(d.Name).trim(), email: d.Email || '', active: truthy_(d.Active)
  }));
  return { manager: m, requests: requests, drivers: drivers, categories: CATEGORIES, today: today_() };
}

function apiDecide_(b) {
  const m = authMgr_(b.token);
  const decision = b.decision === 'Approved' ? 'Approved' : b.decision === 'Denied' ? 'Denied' : null;
  if (!decision) throw new Error('Invalid decision.');
  return withLock_(() => {
    const req = findReq_(b.id);
    if (req.Status !== 'Pending') throw new Error('This request was already ' + req.Status.toLowerCase() + (req.DecidedBy ? ' by ' + req.DecidedBy : '') + '.');
    updateObj_(SH.REQ, req._row, {
      Status: decision, DecidedBy: m.name, DecidedAt: now_(),
      ManagerNote: String(b.note || '').trim().slice(0, 500), Seq: Number(req.Seq || 0)
    });
    const fresh = findReq_(b.id);
    log_(m.name, 'decide', req.ID + ' ' + decision);
    notifyDecision_(fresh);
    return { request: mgrReq_(fresh) };
  });
}

function apiMgrCancel_(b) {
  const m = authMgr_(b.token);
  return withLock_(() => {
    const req = findReq_(b.id);
    if (req.Status !== 'Approved' && req.Status !== 'Pending') throw new Error('Only pending or approved requests can be cancelled.');
    const wasApproved = req.Status === 'Approved';
    const note = String(b.note || '').trim().slice(0, 500);
    updateObj_(SH.REQ, req._row, {
      Status: 'Cancelled', CancelledAt: now_(), CancelledBy: m.name, Seq: Number(req.Seq || 0) + 1,
      ManagerNote: note || req.ManagerNote
    });
    const fresh = findReq_(b.id);
    log_(m.name, 'mgrCancel', req.ID);
    notifyCancel_(fresh, m.name, wasApproved);
    return { request: mgrReq_(fresh) };
  });
}

function apiSaveDriver_(b) {
  const m = authMgr_(b.token);
  const d = b.driver || {};
  const name = String(d.name || '').trim();
  const orig = String(d.originalName || '').trim();
  if (!name) throw new Error('Name is required.');
  return withLock_(() => {
    const roster = readTable_(SH.DRV);
    const existing = orig ? roster.find(x => String(x.Name).trim() === orig) : null;
    const clash = roster.find(x => String(x.Name).trim().toLowerCase() === name.toLowerCase() && x !== existing);
    if (clash) throw new Error('A driver named "' + name + '" already exists. Add a middle initial or last-name initial to tell them apart.');
    const row = { Name: name, Email: String(d.email || '').trim(), Active: d.active !== false };
    if (existing) {
      updateObj_(SH.DRV, existing._row, row);
      // Keep history together if a name is corrected
      if (orig !== name) readTable_(SH.REQ).filter(r => r.DriverName === orig)
        .forEach(r => updateObj_(SH.REQ, r._row, { DriverName: name }));
    } else {
      appendObj_(SH.DRV, row);
    }
    log_(m.name, 'saveDriver', (orig && orig !== name ? orig + ' → ' : '') + name);
    return {};
  });
}

/* ============================== EMAIL + ICS ============================== */

function cfg_(key, fallback) {
  const row = readTable_(SH.CFG).find(x => x.Key === key);
  return row && String(row.Value).trim() ? String(row.Value).trim() : fallback;
}

function managerEmails_() {
  return readTable_(SH.MGR).filter(m => truthy_(m.Active) && m.Email).map(m => String(m.Email).trim());
}

function whenText_(r) {
  if (r.Type === 'Partial') return fmtDate_(r.StartDate) + ', ' + fmtTime_(r.StartTime) + ' – ' + fmtTime_(r.EndTime) + ' (' + r.Hours + ' hrs)';
  if (r.StartDate === r.EndDate) return fmtDate_(r.StartDate) + ' (1 day)';
  return fmtDate_(r.StartDate) + ' – ' + fmtDate_(r.EndDate) + ' (' + r.Days + ' days)';
}

function emailShell_(title, color, rows, footer) {
  const appUrl = cfg_('APP_URL', '');
  const tr = rows.map(([k, v]) =>
    '<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">' + esc_(k) +
    '</td><td style="padding:6px 0;color:#111827">' + esc_(v).replace(/\n/g, '<br>') + '</td></tr>').join('');
  return '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px">' +
    '<div style="background:' + color + ';color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:18px;font-weight:600">' + esc_(title) + '</div>' +
    '<div style="border:1px solid #e5e7eb;border-top:none;padding:16px 18px;border-radius:0 0 8px 8px">' +
    '<table style="border-collapse:collapse;font-size:14px">' + tr + '</table>' +
    (footer ? '<p style="font-size:13px;color:#374151;margin-top:14px">' + footer + '</p>' : '') +
    (appUrl ? '<p style="margin-top:16px"><a href="' + appUrl + '" style="background:#2563eb;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-size:14px">Open Time Off app</a></p>' : '') +
    '</div></div>';
}

function reqRows_(r) {
  return [['Driver', r.DriverName], ['When', whenText_(r)], ['Category', r.Category], ['Reason', r.Reason], ['Request ID', r.ID]];
}

function notifyManagersNew_(r) {
  const to = managerEmails_();
  if (!to.length) return;
  const subj = '[' + cfg_('APP_NAME', 'Time Off') + '] New UTO request – ' + r.DriverName + ' – ' + shortWhen_(r);
  const html = emailShell_('New unpaid time off request', '#d97706', reqRows_(r), 'Either manager can approve or deny in the app.');
  safeMail_({ to: to.join(','), subject: subj, htmlBody: html });
}

function notifyDecision_(r) {
  const appName = cfg_('APP_NAME', 'Time Off');
  const approved = r.Status === 'Approved';
  const rows = reqRows_(r).concat([['Decision', r.Status + ' by ' + r.DecidedBy]]);
  if (r.ManagerNote) rows.push(['Manager note', r.ManagerNote]);
  const color = approved ? '#059669' : '#dc2626';

  // Managers: approval comes with the .ics invite
  const to = managerEmails_();
  if (to.length) {
    const opts = {
      to: to.join(','),
      subject: '[' + appName + '] ' + r.Status + ' – ' + r.DriverName + ' – ' + shortWhen_(r),
      htmlBody: emailShell_('UTO request ' + r.Status.toLowerCase(), color, rows,
        approved ? 'Calendar invite attached — open <b>time-off.ics</b> to add it to Outlook.' : '')
    };
    if (approved) opts.attachments = [icsBlob_(r, 'REQUEST', to)];
    safeMail_(opts);
  }

  // Driver (if we have an email on file)
  if (r.DriverEmail) {
    safeMail_({
      to: r.DriverEmail,
      subject: '[' + appName + '] Your time off request was ' + r.Status.toLowerCase(),
      htmlBody: emailShell_('Your request was ' + r.Status.toLowerCase(), color,
        [['When', whenText_(r)], ['Decision', r.Status + ' by ' + r.DecidedBy]].concat(r.ManagerNote ? [['Note', r.ManagerNote]] : []), '')
    });
  }
}

function notifyCancel_(r, byName, wasApproved) {
  const appName = cfg_('APP_NAME', 'Time Off');
  const to = managerEmails_();
  const rows = reqRows_(r).concat([['Cancelled by', byName]]);
  if (to.length) {
    const opts = {
      to: to.join(','),
      subject: '[' + appName + '] Cancelled – ' + r.DriverName + ' – ' + shortWhen_(r),
      htmlBody: emailShell_('UTO request cancelled', '#4b5563', rows,
        wasApproved ? 'The attached cancellation removes the event from Outlook calendars.' : '')
    };
    if (wasApproved) opts.attachments = [icsBlob_(r, 'CANCEL', to)];
    safeMail_(opts);
  }
  if (r.DriverEmail && byName !== r.DriverName) {
    safeMail_({
      to: r.DriverEmail,
      subject: '[' + appName + '] Your time off request was cancelled',
      htmlBody: emailShell_('Your request was cancelled', '#4b5563', [['When', whenText_(r)], ['Cancelled by', byName]], '')
    });
  }
}

/**
 * Builds an iCalendar invite. Same UID across approve/cancel so Outlook
 * updates or removes the original event. TRANSP:TRANSPARENT keeps it from
 * blocking the manager's own availability.
 */
function icsBlob_(r, method, attendees) {
  const organizer = Session.getEffectiveUser().getEmail();
  const uid = r.ID + '@lwh-timeoff';
  const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  let dtStart, dtEnd;
  if (r.Type === 'Partial') {
    dtStart = 'DTSTART:' + utcStamp_(r.StartDate, r.StartTime);
    dtEnd = 'DTEND:' + utcStamp_(r.StartDate, r.EndTime);
  } else {
    dtStart = 'DTSTART;VALUE=DATE:' + r.StartDate.replace(/-/g, '');
    dtEnd = 'DTEND;VALUE=DATE:' + addDays_(r.EndDate, 1).replace(/-/g, '');
  }
  const desc = 'Unpaid time off (' + r.Category + ')\\nReason: ' + icsEsc_(r.Reason) +
    '\\nApproved by: ' + icsEsc_(r.DecidedBy || '') + '\\nRequest ID: ' + r.ID;
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Logistics Warehouse//Time Off Requests//EN', 'VERSION:2.0',
    'CALSCALE:GREGORIAN', 'METHOD:' + method,
    'BEGIN:VEVENT',
    'UID:' + uid, 'DTSTAMP:' + stamp, 'SEQUENCE:' + Number(r.Seq || 0),
    dtStart, dtEnd,
    'SUMMARY:' + icsEsc_('UTO – ' + r.DriverName),
    'DESCRIPTION:' + desc,
    'ORGANIZER;CN=' + icsEsc_(cfg_('APP_NAME', 'Time Off')) + ':mailto:' + organizer
  ].concat(attendees.map(a => 'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:' + a))
   .concat([
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
    'TRANSP:TRANSPARENT', 'CLASS:PUBLIC',
    'X-MICROSOFT-CDO-BUSYSTATUS:FREE', 'X-MICROSOFT-CDO-ALLDAYEVENT:' + (r.Type === 'Partial' ? 'FALSE' : 'TRUE'),
    'END:VEVENT', 'END:VCALENDAR'
  ]);
  const body = lines.map(foldIcs_).join('\r\n') + '\r\n';
  return Utilities.newBlob(body, 'text/calendar; charset=utf-8; method=' + method,
    method === 'CANCEL' ? 'time-off-cancel.ics' : 'time-off.ics');
}

function pendingReminder() {
  const hrs = Number(cfg_('REMINDER_HOURS', '24'));
  const cutoff = Utilities.formatDate(new Date(Date.now() - hrs * 3600 * 1000), TZ, 'yyyy-MM-dd HH:mm');
  const stale = readTable_(SH.REQ).filter(r => r.Status === 'Pending' && r.Submitted <= cutoff);
  const to = managerEmails_();
  if (!stale.length || !to.length) return;
  const rows = stale.map(r => [r.DriverName, whenText_(r) + ' — ' + r.Category]);
  safeMail_({
    to: to.join(','),
    subject: '[' + cfg_('APP_NAME', 'Time Off') + '] ' + stale.length + ' request(s) waiting on a decision',
    htmlBody: emailShell_(stale.length + ' pending request(s) older than ' + hrs + ' hrs', '#d97706', rows, '')
  });
}

function safeMail_(opts) {
  try {
    opts.name = cfg_('APP_NAME', 'LWH Time Off Requests');
    MailApp.sendEmail(opts);
  } catch (err) {
    log_('system', 'mailError', String(err));
  }
}

/* ============================== AUTH ============================== */

function authDriver_(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Select your name.');
  const d = readTable_(SH.DRV).find(x => String(x.Name).trim() === n);
  if (!d || !truthy_(d.Active)) throw new Error('Driver not found. See a manager to be added.');
  d.Name = String(d.Name).trim();
  return d;
}

function authMgr_(token) {
  const raw = token && CacheService.getScriptCache().get('tok_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED');
  return JSON.parse(raw);
}

/* ============================== SHAPES ============================== */

function publicReq_(r) {
  return {
    id: r.ID, submitted: String(r.Submitted), type: r.Type, startDate: r.StartDate, endDate: r.EndDate,
    startTime: r.StartTime, endTime: r.EndTime, days: Number(r.Days) || 0, hours: Number(r.Hours) || 0,
    category: r.Category, reason: r.Reason, status: r.Status, decidedBy: r.DecidedBy,
    decidedAt: String(r.DecidedAt || ''), managerNote: r.ManagerNote, cancelledBy: r.CancelledBy
  };
}

function mgrReq_(r) {
  return Object.assign(publicReq_(r), { driverName: r.DriverName, cancelledAt: String(r.CancelledAt || '') });
}

/* ============================== SHEET HELPERS ============================== */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup().');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift() || [];
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = normCell_(row[j], h); });
    return o;
  }).filter(o => head.some(h => o[h] !== ''));
}

function normCell_(v, h) {
  if (v instanceof Date) {
    if (h === 'StartTime' || h === 'EndTime') return Utilities.formatDate(v, TZ, 'HH:mm');
    if (h === 'StartDate' || h === 'EndDate') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  }
  return v === null || v === undefined ? '' : (typeof v === 'string' ? v.trim() : v);
}

function appendObj_(name, obj) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, head.length).setValues([head.map(h => obj[h] !== undefined ? obj[h] : '')]);
}

function updateObj_(name, row, patch) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(patch).forEach(k => {
    const c = head.indexOf(k);
    if (c > -1) sh.getRange(row, c + 1).setValue(patch[k]);
  });
}

function findReq_(id) {
  const r = readTable_(SH.REQ).find(x => String(x.ID) === String(id));
  if (!r) throw new Error('Request not found.');
  return r;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('System busy, please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function log_(who, action, detail) {
  try { sheet_(SH.LOG).appendRow([now_(), who, action, detail]); } catch (e) {}
}

/* ============================== UTILS ============================== */

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function newId_() { return 'UTO-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase(); }
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function isTime_(s) { return /^\d{2}:\d{2}$/.test(String(s || '')); }
function mins_(t) { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function truthy_(v) { return v === true || /^(true|yes|y|1)$/i.test(String(v)); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function dateObj_(s) { const p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function dayDiff_(a, b) { return Math.round((dateObj_(b) - dateObj_(a)) / 86400000); }
function addDays_(s, n) { const d = dateObj_(s); d.setUTCDate(d.getUTCDate() + n); return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
function fmtDate_(s) { return Utilities.formatDate(dateObj_(s), 'UTC', 'EEE MMM d, yyyy'); }
function fmtTime_(t) { let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function shortWhen_(r) {
  const f = s => Utilities.formatDate(dateObj_(s), 'UTC', 'M/d');
  return r.StartDate === r.EndDate ? f(r.StartDate) : f(r.StartDate) + '–' + f(r.EndDate);
}
function utcStamp_(date, time) {
  const d = Utilities.parseDate(date + ' ' + time, TZ, 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}
function icsEsc_(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function foldIcs_(line) {
  const out = [];
  while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); }
  out.push(line);
  return out.join('\r\n');
}
