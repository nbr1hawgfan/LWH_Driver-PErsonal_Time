/* LWH Time Off Requests — front end (vanilla JS, no build) */
(() => {
  'use strict';

  const API = (window.UTO_CONFIG || {}).API_URL || '';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const LS_DRIVER = 'uto_driver';
  const SS_MGR = 'uto_mgr';

  const state = {
    view: 'request',
    driver: load(localStorage, LS_DRIVER),      // { empId, pin, name }
    mgr: load(sessionStorage, SS_MGR),          // { token, name }
    meta: { categories: [], maxDays: 30, today: localToday() },
    reqType: 'Full',
    mine: [],
    m: { requests: [], drivers: [], sub: 'pending', sort: { key: 'occ', asc: false } },
    pin: ''
  };

  /* ------------------------------ helpers ------------------------------ */
  function load(store, key) { try { return JSON.parse(store.getItem(key)) || null; } catch (e) { return null; } }
  function save(store, key, val) { try { val ? store.setItem(key, JSON.stringify(val)) : store.removeItem(key); } catch (e) {} }
  function localToday() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function dObj(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = dObj(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayDiff(a, b) { return Math.round((dObj(b) - dObj(a)) / 86400000); }
  function fmtD(s, withYear) { return s ? dObj(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined }) : ''; }
  function fmtT(t) { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }
  function when(r) {
    if (r.type === 'Partial') return fmtD(r.startDate) + ' · ' + fmtT(r.startTime) + '–' + fmtT(r.endTime);
    return r.startDate === r.endDate ? fmtD(r.startDate) : fmtD(r.startDate) + ' – ' + fmtD(r.endDate);
  }
  function amount(r) { return r.type === 'Partial' ? r.hours + ' hrs' : r.days + (r.days === 1 ? ' day' : ' days'); }
  function mins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast ' + (kind || ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 5000 : 3000);
  }
  function busy(on) { $('#busy').hidden = !on; }

  async function api(action, data = {}) {
    if (!API || API.indexOf('PASTE') === 0) throw new Error('API_URL is not set in config.js');
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight with GAS
      body: JSON.stringify(Object.assign({ action }, data)),
      redirect: 'follow'
    });
    const j = await res.json();
    if (!j.ok) {
      if (j.error === 'SESSION_EXPIRED') { mgrSignOut(true); throw new Error('Manager session expired. Sign in again.'); }
      throw new Error(j.error || 'Request failed');
    }
    return j;
  }

  async function run(fn, quiet) {
    if (!quiet) busy(true);
    try { return await fn(); }
    catch (e) { toast(e.message, 'err'); }
    finally { if (!quiet) busy(false); }
  }

  /* ------------------------------ navigation ------------------------------ */
  function show(view) {
    state.view = view;
    $$('.bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => { v.hidden = true; });
    if ((view === 'request' || view === 'mine') && !state.driver) { $('#view-signin').hidden = false; }
    else $('#view-' + view).hidden = false;

    if (view === 'mine' && state.driver) loadMine();
    if (view === 'mgr') renderMgrShell();
    updateWho();
  }

  function updateWho() {
    $('#whoami').textContent = state.view === 'mgr' && state.mgr ? 'Manager · ' + state.mgr.name
      : state.driver ? state.driver.name + ' · #' + state.driver.empId : 'Logistics Warehouse';
  }

  /* ------------------------------ driver sign-in ------------------------------ */
  $('#formSignin').addEventListener('submit', e => {
    e.preventDefault();
    const empId = $('#inEmp').value.trim();
    const pin = $('#inPin').value.trim();
    run(async () => {
      try {
        const j = await api('identify', { empId, pin });
        state.driver = { empId: j.driver.empId, pin, name: j.driver.name };
        save(localStorage, LS_DRIVER, state.driver);
        $('#inPin').value = ''; $('#pinWrap').hidden = true;
        toast('Welcome, ' + j.driver.name, 'ok');
        show(state.view === 'mgr' ? 'request' : state.view);
      } catch (err) {
        if (/PIN/.test(err.message)) { $('#pinWrap').hidden = false; $('#inPin').focus(); }
        throw err;
      }
    });
  });

  $('#btnSignout').addEventListener('click', () => {
    if (!confirm('Sign out of this device?')) return;
    state.driver = null; state.mine = [];
    save(localStorage, LS_DRIVER, null);
    show('request');
  });

  /* ------------------------------ new request ------------------------------ */
  $$('.seg-btn').forEach(b => b.addEventListener('click', () => {
    state.reqType = b.dataset.type;
    $$('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    const partial = state.reqType === 'Partial';
    $('#wrapEnd').hidden = partial;
    $('#wrapTimes').hidden = !partial;
    $('#lblStart').textContent = partial ? 'Date' : 'Start date';
    updateSummary();
  }));

  ['#inStart', '#inEnd', '#inT1', '#inT2'].forEach(s => $(s).addEventListener('change', () => {
    if (s === '#inStart' && state.reqType === 'Full') {
      const st = $('#inStart').value, en = $('#inEnd').value;
      $('#inEnd').min = st;
      if (st && (!en || en < st)) $('#inEnd').value = st;
    }
    updateSummary();
  }));

  $('#inReason').addEventListener('input', () => { $('#reasonCount').textContent = $('#inReason').value.length + ' / 1000'; });

  function computeReq() {
    const type = state.reqType;
    const startDate = $('#inStart').value;
    const r = { type, startDate, category: $('#inCat').value, reason: $('#inReason').value.trim() };
    if (!startDate) return { r, err: 'Pick your dates' , soft: true };
    if (type === 'Full') {
      r.endDate = $('#inEnd').value || startDate;
      if (r.endDate < startDate) return { r, err: 'End date is before start date' };
      const days = dayDiff(startDate, r.endDate) + 1;
      if (days > state.meta.maxDays) return { r, err: 'Max ' + state.meta.maxDays + ' days per request' };
      r.days = days;
    } else {
      r.endDate = startDate;
      r.startTime = $('#inT1').value; r.endTime = $('#inT2').value;
      if (!r.startTime || !r.endTime) return { r, err: 'Pick start and end times', soft: true };
      if (r.endTime <= r.startTime) return { r, err: 'End time must be after start time' };
      r.hours = Math.round((mins(r.endTime) - mins(r.startTime)) / 60 * 100) / 100;
    }
    return { r };
  }

  function updateSummary() {
    const { r, err, soft } = computeReq();
    const el = $('#reqSummary');
    el.classList.toggle('err', !!err && !soft);
    if (err) { el.textContent = err; return; }
    const past = r.startDate < localToday() ? ' · ⚠ starts in the past' : '';
    el.textContent = (r.type === 'Partial'
      ? fmtD(r.startDate, true) + ' · ' + fmtT(r.startTime) + '–' + fmtT(r.endTime) + ' · ' + r.hours + ' hrs'
      : (r.days === 1 ? fmtD(r.startDate, true) : fmtD(r.startDate) + ' – ' + fmtD(r.endDate, true)) + ' · ' + r.days + (r.days === 1 ? ' day' : ' days')) + past;
  }

  $('#formReq').addEventListener('submit', e => {
    e.preventDefault();
    const { r, err } = computeReq();
    if (err) return toast(err, 'err');
    if (!r.category) return toast('Pick a reason category', 'err');
    if (r.reason.length < 5) return toast('Please explain the reason', 'err');
    run(async () => {
      await api('submit', { empId: state.driver.empId, pin: state.driver.pin, request: r });
      toast('Request submitted. Managers have been notified.', 'ok');
      $('#formReq').reset(); $('#reasonCount').textContent = '0 / 1000';
      $$('.seg-btn')[0].click();
      show('mine');
    });
  });

  /* ------------------------------ my requests ------------------------------ */
  function loadMine(quiet) {
    if (!state.mine.length) $('#mineList').innerHTML = '<div class="empty">Loading…</div>';
    return run(async () => {
      const j = await api('myRequests', { empId: state.driver.empId, pin: state.driver.pin });
      state.mine = j.requests;
      renderMine();
    }, true);
  }

  function renderMine() {
    const el = $('#mineList');
    if (!state.mine.length) { el.innerHTML = '<div class="empty">No requests yet.</div>'; return; }
    const today = localToday();
    el.innerHTML = state.mine.map(r => `
      <div class="req ${r.status}">
        <div class="req-top">
          <div>
            <div class="req-when">${esc(when(r))}</div>
            <div class="req-meta">${esc(amount(r))} · ${esc(r.category)} · ${esc(r.id)}</div>
          </div>
          <span class="pill ${r.status}">${r.status}</span>
        </div>
        <div class="req-reason">${esc(r.reason)}</div>
        ${r.decidedBy ? `<div class="req-meta">${r.status === 'Cancelled' ? '' : esc(r.status) + ' by ' + esc(r.decidedBy) + ' · ' + esc(r.decidedAt)}</div>` : ''}
        ${r.status === 'Cancelled' && r.cancelledBy ? `<div class="req-meta">Cancelled by ${esc(r.cancelledBy)}</div>` : ''}
        ${r.managerNote ? `<div class="req-note">Manager note: ${esc(r.managerNote)}</div>` : ''}
        ${(r.status === 'Pending' || r.status === 'Approved') && r.endDate >= today
          ? `<div class="req-actions"><button class="btn bad small" data-cancel="${esc(r.id)}">Cancel request</button></div>` : ''}
      </div>`).join('');
  }

  $('#mineList').addEventListener('click', e => {
    const id = e.target.dataset.cancel;
    if (!id || !confirm('Cancel this request?')) return;
    run(async () => {
      await api('driverCancel', { empId: state.driver.empId, pin: state.driver.pin, id });
      toast('Request cancelled', 'ok');
      await loadMine(true);
    });
  });

  /* ------------------------------ manager: login ------------------------------ */
  function renderPin() { $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < state.pin.length)); }

  $('#keypad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'clr') state.pin = '';
    else if (k === 'go') return mgrLogin();
    else if (state.pin.length < 6) state.pin += b.textContent;
    renderPin();
  });
  document.addEventListener('keydown', e => {
    if (state.view !== 'mgr' || state.mgr || $('#modal').open) return;
    if (/^\d$/.test(e.key) && state.pin.length < 6) { state.pin += e.key; renderPin(); }
    else if (e.key === 'Backspace') { state.pin = state.pin.slice(0, -1); renderPin(); }
    else if (e.key === 'Enter') mgrLogin();
  });

  function mgrLogin() {
    if (!state.pin) return;
    const pin = state.pin;
    run(async () => {
      try {
        const j = await api('mgrLogin', { pin });
        state.mgr = { token: j.token, name: j.manager.name };
        save(sessionStorage, SS_MGR, state.mgr);
        state.pin = ''; renderPin();
        renderMgrShell();
      } catch (err) {
        state.pin = ''; renderPin();
        const d = $('#pinDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
        throw err;
      }
    });
  }

  function mgrSignOut(silent) {
    if (state.mgr && !silent) api('mgrLogout', { token: state.mgr.token }).catch(() => {});
    state.mgr = null; save(sessionStorage, SS_MGR, null);
    if (state.view === 'mgr') renderMgrShell();
  }
  $('#btnMgrOut').addEventListener('click', () => mgrSignOut());

  function renderMgrShell() {
    $('#mgrLogin').hidden = !!state.mgr;
    $('#mgrPanel').hidden = !state.mgr;
    updateWho();
    if (state.mgr) { $('#mgrWho').textContent = 'Signed in as ' + state.mgr.name; loadMgr(); }
  }

  function loadMgr(quiet) {
    return run(async () => {
      const j = await api('mgrData', { token: state.mgr.token });
      state.m.requests = j.requests; state.m.drivers = j.drivers; state.meta.today = j.today;
      buildYearOptions();
      renderMgr();
    }, quiet);
  }

  /* ------------------------------ manager: views ------------------------------ */
  $('#mgrTabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.m.sub = b.dataset.sub;
    $$('#mgrTabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('#mgrPanel .sub').forEach(s => { s.hidden = s.id !== 'sub-' + state.m.sub; });
    renderMgr();
  });

  function renderMgr() {
    const pending = state.m.requests.filter(r => r.status === 'Pending');
    const pc = $('#pendCount'); pc.textContent = pending.length; pc.classList.toggle('zero', !pending.length);
    ({ pending: renderPending, upcoming: renderUpcoming, drivers: renderDrivers, all: renderAll })[state.m.sub]();
  }

  function overlaps(a, b) { return a.startDate <= b.endDate && a.endDate >= b.startDate; }

  function driverStats(empId, year) {
    const today = state.meta.today, d90 = addDays(today, -90);
    const reqs = state.m.requests.filter(r => r.empId === empId);
    const inYear = reqs.filter(r => !year || r.startDate.slice(0, 4) === String(year));
    const appr = inYear.filter(r => r.status === 'Approved');
    return {
      reqs, total: inYear.length,
      occ: appr.length,
      days: appr.reduce((s, r) => s + (r.days || 0), 0),
      hours: Math.round(appr.reduce((s, r) => s + (r.hours || 0), 0) * 100) / 100,
      denied: inYear.filter(r => r.status === 'Denied').length,
      r90: reqs.filter(r => r.status === 'Approved' && r.endDate >= d90 && r.startDate <= today).length,
      last: reqs.reduce((m, r) => (r.startDate > m ? r.startDate : m), '')
    };
  }

  function reqCard(r, opts = {}) {
    return `
      <div class="req ${r.status}">
        <div class="req-top">
          <div>
            <div class="req-name"><a href="#" data-driver="${esc(r.empId)}" style="color:inherit">${esc(r.driverName)}</a> <span class="muted small">#${esc(r.empId)}</span></div>
            <div class="req-when">${esc(when(r))}</div>
            <div class="req-meta">${esc(amount(r))} · ${esc(r.category)} · submitted ${esc(r.submitted)} · ${esc(r.id)}</div>
          </div>
          <span class="pill ${r.status}">${r.status}</span>
        </div>
        <div class="req-reason">${esc(r.reason)}</div>
        ${opts.flags || ''}
        ${r.decidedBy && r.status !== 'Pending' ? `<div class="req-meta">${r.status === 'Cancelled' ? 'Was decided' : esc(r.status)} by ${esc(r.decidedBy)} · ${esc(r.decidedAt)}</div>` : ''}
        ${r.status === 'Cancelled' ? `<div class="req-meta">Cancelled by ${esc(r.cancelledBy)} · ${esc(r.cancelledAt)}</div>` : ''}
        ${r.managerNote ? `<div class="req-note">Note: ${esc(r.managerNote)}</div>` : ''}
        ${opts.actions || ''}
      </div>`;
  }

  function renderPending() {
    const el = $('#pendList');
    const list = state.m.requests.filter(r => r.status === 'Pending').sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (!list.length) { el.innerHTML = '<div class="empty">Nothing waiting. 👍</div>'; return; }
    const yr = state.meta.today.slice(0, 4);
    el.innerHTML = list.map(r => {
      const st = driverStats(r.empId, yr);
      const others = state.m.requests.filter(x => x.status === 'Approved' && x.empId !== r.empId && overlaps(x, r));
      const flags = `<div class="flags">
        <span class="flag ${st.occ >= 3 ? 'warn' : ''}">${st.occ} approved occurrence${st.occ === 1 ? '' : 's'} in ${yr}</span>
        <span class="flag ${st.r90 >= 2 ? 'warn' : ''}">${st.r90} in last 90 days</span>
        ${others.length ? `<span class="flag warn">${others.length} other driver${others.length === 1 ? '' : 's'} already off: ${esc(others.map(o => o.driverName).join(', '))}</span>` : ''}
        ${r.startDate < state.meta.today ? '<span class="flag warn">Date already passed</span>' : ''}
      </div>`;
      const actions = `<div class="req-actions">
        <input placeholder="Note to driver (optional)" data-note="${esc(r.id)}" maxlength="500">
        <button class="btn ok" data-decide="Approved" data-id="${esc(r.id)}">Approve</button>
        <button class="btn bad" data-decide="Denied" data-id="${esc(r.id)}">Deny</button>
      </div>`;
      return reqCard(r, { flags, actions });
    }).join('');
  }

  function renderUpcoming() {
    const el = $('#upList');
    const today = state.meta.today, end = addDays(today, 30);
    const appr = state.m.requests.filter(r => r.status === 'Approved' && r.endDate >= today && r.startDate <= end);
    if (!appr.length) { el.innerHTML = '<div class="empty">No approved time off in the next 30 days.</div>'; return; }
    let html = '';
    for (let d = today; d <= end; d = addDays(d, 1)) {
      const out = appr.filter(r => r.startDate <= d && r.endDate >= d);
      if (!out.length) continue;
      html += `<div class="day-group"><div class="day-head"><span>${esc(fmtD(d))}${d === today ? ' · Today' : ''}</span><span>${out.length} out</span></div>
        ${out.map(r => `<div class="day-row"><a href="#" data-driver="${esc(r.empId)}" style="color:inherit">${esc(r.driverName)}</a>
          <span class="muted">${r.type === 'Partial' ? esc(fmtT(r.startTime) + '–' + fmtT(r.endTime)) : 'All day'}</span></div>`).join('')}</div>`;
    }
    el.innerHTML = html;
  }

  function buildYearOptions() {
    const sel = $('#drvYear');
    const cur = sel.value || state.meta.today.slice(0, 4);
    const years = new Set([state.meta.today.slice(0, 4)]);
    state.m.requests.forEach(r => years.add(r.startDate.slice(0, 4)));
    sel.innerHTML = '<option value="">All years</option>' + [...years].sort().reverse().map(y => `<option>${y}</option>`).join('');
    sel.value = cur;
  }

  function renderDrivers() {
    const year = $('#drvYear').value;
    const q = $('#drvSearch').value.trim().toLowerCase();
    const known = new Map(state.m.drivers.map(d => [d.empId, d]));
    // Include anyone who has requests even if removed from roster
    state.m.requests.forEach(r => { if (!known.has(r.empId)) known.set(r.empId, { empId: r.empId, name: r.driverName, active: false }); });
    let rows = [...known.values()]
      .filter(d => !q || d.name.toLowerCase().includes(q) || d.empId.includes(q))
      .map(d => Object.assign({ d }, driverStats(d.empId, year), { name: d.name }));
    const { key, asc } = state.m.sort;
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return (asc ? c : -c) || a.name.localeCompare(b.name);
    });
    $$('#drvTable th').forEach(th => {
      th.classList.toggle('sorted', th.dataset.sort === key);
      th.classList.toggle('asc', th.dataset.sort === key && asc);
    });
    $('#drvTable tbody').innerHTML = rows.length ? rows.map(r => `
      <tr data-driver="${esc(r.d.empId)}" class="${r.d.active ? '' : 'inactive'}">
        <td><b>${esc(r.name)}</b> <span class="muted small">#${esc(r.d.empId)}</span></td>
        <td class="${r.occ >= 3 ? 'hot' : ''}">${r.occ}</td>
        <td>${r.days}</td>
        <td>${r.hours}</td>
        <td class="${r.r90 >= 2 ? 'hot' : ''}">${r.r90}</td>
        <td>${r.denied}</td>
        <td>${r.last ? esc(dObj(r.last).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })) : '—'}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">No drivers found.</td></tr>';
  }

  $('#drvTable thead').addEventListener('click', e => {
    const k = e.target.dataset.sort; if (!k) return;
    const s = state.m.sort;
    s.asc = s.key === k ? !s.asc : k === 'name';
    s.key = k;
    renderDrivers();
  });
  $('#drvSearch').addEventListener('input', renderDrivers);
  $('#drvYear').addEventListener('change', renderDrivers);

  function filteredAll() {
    const q = $('#allSearch').value.trim().toLowerCase();
    const st = $('#allStatus').value;
    return state.m.requests.filter(r => (!st || r.status === st) &&
      (!q || [r.driverName, r.empId, r.reason, r.category, r.id].join(' ').toLowerCase().includes(q)));
  }

  function renderAll() {
    const list = filteredAll();
    $('#allList').innerHTML = list.length
      ? list.slice(0, 200).map(r => reqCard(r, { actions: cancelAction(r) })).join('') + (list.length > 200 ? `<p class="muted small center">Showing 200 of ${list.length}. Narrow your search or export CSV.</p>` : '')
      : '<div class="empty">No matching requests.</div>';
  }
  function cancelAction(r) {
    return (r.status === 'Approved' || r.status === 'Pending') && r.endDate >= state.meta.today
      ? `<div class="req-actions"><button class="btn bad small" data-mcancel="${esc(r.id)}">${r.status === 'Approved' ? 'Revoke / cancel' : 'Cancel'}</button></div>` : '';
  }
  $('#allSearch').addEventListener('input', renderAll);
  $('#allStatus').addEventListener('change', renderAll);

  $('#btnCsv').addEventListener('click', () => {
    const cols = ['id', 'submitted', 'empId', 'driverName', 'type', 'startDate', 'endDate', 'startTime', 'endTime', 'days', 'hours', 'category', 'reason', 'status', 'decidedBy', 'decidedAt', 'managerNote', 'cancelledBy', 'cancelledAt'];
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')].concat(filteredAll().map(r => cols.map(c => q(r[c])).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'uto-requests-' + state.meta.today + '.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ------------------------------ manager: actions ------------------------------ */
  function mgrClick(e) {
    const t = e.target;
    const drv = t.closest('[data-driver]');
    if (drv) { e.preventDefault(); return openDriver(drv.dataset.driver); }

    if (t.dataset.decide) {
      const id = t.dataset.id, decision = t.dataset.decide;
      const note = ($(`[data-note="${CSS.escape(id)}"]`) || {}).value || '';
      const r = state.m.requests.find(x => x.id === id);
      if (!confirm(`${decision === 'Approved' ? 'Approve' : 'Deny'} ${r.driverName} — ${when(r)}?`)) return;
      run(async () => {
        await api('decide', { token: state.mgr.token, id, decision, note });
        toast(decision === 'Approved' ? 'Approved — invite emailed' : 'Denied', 'ok');
        await loadMgr(true);
      });
    }

    if (t.dataset.mcancel) {
      const id = t.dataset.mcancel;
      const r = state.m.requests.find(x => x.id === id);
      const note = prompt(`Cancel ${r.driverName} — ${when(r)}?\nOptional note to driver:`, '');
      if (note === null) return;
      run(async () => {
        await api('mgrCancel', { token: state.mgr.token, id, note });
        toast('Request cancelled' + (r.status === 'Approved' ? ' — calendar cancellation sent' : ''), 'ok');
        await loadMgr(true);
        if ($('#modal').open) openDriver(r.empId);
      });
    }
  }
  $('#mgrPanel').addEventListener('click', mgrClick);

  function openDriver(empId) {
    const d = state.m.drivers.find(x => x.empId === empId) || { empId, name: (state.m.requests.find(r => r.empId === empId) || {}).driverName || empId, active: false };
    const yr = state.meta.today.slice(0, 4);
    const st = driverStats(empId, yr);
    const all = driverStats(empId, '');
    const list = st.reqs.slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
    $('#modalTitle').textContent = d.name + '  #' + empId;
    $('#modalBody').innerHTML = `
      <div class="stat-row">
        <div class="stat"><b>${st.occ}</b><span>Occ. ${yr}</span></div>
        <div class="stat"><b>${st.days}</b><span>Days ${yr}</span></div>
        <div class="stat"><b>${st.r90}</b><span>Last 90d</span></div>
        <div class="stat"><b>${all.occ}</b><span>All-time</span></div>
      </div>
      <div class="list">${list.length ? list.map(r => reqCard(r, { actions: cancelAction(r) })).join('') : '<div class="empty">No requests.</div>'}</div>
      ${state.m.drivers.find(x => x.empId === empId) ? `<button class="btn ghost block" data-editdriver="${esc(empId)}">Edit driver</button>` : ''}`;
    openModal();
  }

  /* ------------------------------ manager: roster ------------------------------ */
  function driverForm(d) {
    const isNew = !d;
    d = d || { empId: '', name: '', email: '', active: true };
    $('#modalTitle').textContent = isNew ? 'Add driver' : 'Edit driver';
    $('#modalBody').innerHTML = `
      <form id="formDriver">
        <label>Employee #<input name="empId" value="${esc(d.empId)}" ${isNew ? '' : 'readonly'} required></label>
        <label>Name<input name="name" value="${esc(d.name)}" required></label>
        <label>Email <span class="muted small">(optional — gets decision emails)</span><input name="email" type="email" value="${esc(d.email)}"></label>
        <label>Driver PIN <span class="muted small">(optional — ${isNew ? 'leave blank for none' : d.hasPin ? 'set; leave blank to keep, type NONE to remove' : 'none set'})</span><input name="pin" inputmode="numeric"></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${d.active ? 'checked' : ''} style="width:auto;margin:0"> Active</label>
        <button class="btn primary block" type="submit">Save</button>
      </form>`;
    $('#formDriver').addEventListener('submit', ev => {
      ev.preventDefault();
      const f = ev.target;
      const pinRaw = f.pin.value.trim();
      const payload = { empId: f.empId.value.trim(), name: f.name.value.trim(), email: f.email.value.trim(), active: f.active.checked };
      if (pinRaw.toUpperCase() === 'NONE') payload.pin = '';
      else if (pinRaw || isNew) payload.pin = pinRaw;
      run(async () => {
        await api('saveDriver', { token: state.mgr.token, driver: payload });
        toast('Driver saved', 'ok');
        closeModal();
        await loadMgr(true);
      });
    });
    openModal();
  }
  $('#btnAddDriver').addEventListener('click', () => driverForm(null));
  $('#modalBody').addEventListener('click', e => {
    const id = e.target.dataset.editdriver;
    if (id) return driverForm(state.m.drivers.find(x => x.empId === id));
    if (state.mgr) mgrClick(e);
  });

  function openModal() { const m = $('#modal'); if (!m.open) m.showModal(); }
  function closeModal() { $('#modal').close(); }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  /* ------------------------------ global ------------------------------ */
  $('#bottomnav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });
  $('#btnRefresh').addEventListener('click', () => {
    if (state.view === 'mgr' && state.mgr) loadMgr();
    else if (state.view === 'mine' && state.driver) run(() => loadMine(true));
    else location.reload();
  });

  async function init() {
    const sel = $('#inCat');
    try {
      const j = await api('meta');
      state.meta = Object.assign(state.meta, j);
    } catch (e) {
      state.meta.categories = ['Personal', 'Family', 'Medical', 'Vehicle / Transportation', 'Bereavement', 'Court / Legal', 'Weather', 'Other'];
      toast(e.message, 'err');
    }
    sel.innerHTML = '<option value="">Select…</option>' + state.meta.categories.map(c => `<option>${esc(c)}</option>`).join('');
    show(location.hash === '#manager' ? 'mgr' : 'request');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  init();
})();
