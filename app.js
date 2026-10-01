// Sales CRM: UI. Talks to the database only through window.CRM_API (see api.js).
(() => {
  'use strict';

  const api = window.CRM_API;
  const cfg = window.CRM_CONFIG || {};
  const STATUSES = ['New', 'Hot', 'Warm', 'Cold', 'Converted', 'Not Interested'];
  const CLOSED = ['Converted', 'Not Interested'];
  const ACT_TYPES = ['Call', 'Meeting', 'WhatsApp', 'Email', 'Note'];
  const PAGE_SIZE = 50;
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  // Column headers of the team's Excel sheet (used for template + export)
  const SHEET_HEADERS = ['Sr.no', 'Client_Name', 'Location', 'Email id', 'Contact', 'Remark', 'Status', 'PMS', 'AIF', 'MF',
    'Last connected', 'Next_Action', 'Next Connect', 'Products Pitched', 'Day Since Contacted', 'Follow ups', 'Assigned To'];

  // ---------- State ----------
  let me = null;
  let users = [];
  let leads = [];
  let view = 'dashboard';
  let page = 0;
  let sort = { key: 'next_connect', asc: true };
  let filters = { q: '', status: '', fu: '', product: '', owner: '' };
  const selected = new Set();
  let editing = null;      // lead being edited in dialog
  let pendingImport = null; // parsed rows waiting for confirmation

  // ---------- Helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const isAdmin = () => me && me.role === 'admin';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
    return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(s) {
    return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function daysSince(l) {
    if (!l.last_connected) return null;
    const a = new Date(l.last_connected + 'T00:00:00'), b = new Date(today() + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  // Same meaning as the "Follow ups" column in the team sheet
  function fuState(l) {
    if (!l.next_connect || CLOSED.includes(l.status)) return '';
    const t = today();
    return l.next_connect < t ? 'OVERDUE' : l.next_connect === t ? 'TODAY' : 'UPCOMING';
  }
  function userName(id) {
    const u = users.find(x => x.id === id);
    return u ? (u.full_name || u.email) : (id ? 'Unknown' : 'Unassigned');
  }
  function phoneKey(p) {
    const digits = String(p || '').split(/[\/;,]/)[0].replace(/\D/g, '');
    return digits.length >= 8 ? digits.slice(-10) : '';
  }
  function statusPill(s) {
    const cls = String(s || '').replace(/\s+/g, '-').toLowerCase();
    return `<span class="pill st-${esc(cls)}">${esc(s || '-')}</span>`;
  }
  function fuPill(l) {
    const s = fuState(l);
    return s ? `<span class="fu fu-${s.toLowerCase()}">${s}</span>` : '';
  }
  function products(l) {
    return ['pms', 'aif', 'mf'].filter(k => l[k]).map(k => `<span class="tag">${k.toUpperCase()}</span>`).join(' ');
  }
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error-toast' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
  }
  async function guard(fn) {
    try { return await fn(); }
    catch (e) { console.error(e); toast(e.message || String(e), true); }
  }
  function activeUsers() { return users.filter(u => u.active); }
  function userOptions(selectedId, { includeAll, includeUnassigned } = {}) {
    let html = includeAll ? `<option value="">All team members</option>` : '';
    if (includeUnassigned) html += `<option value="__none">Unassigned</option>`;
    return html + activeUsers().map(u =>
      `<option value="${esc(u.id)}" ${u.id === selectedId ? 'selected' : ''}>${esc(u.full_name || u.email)}${u.role === 'admin' ? ' (admin)' : ''}</option>`).join('');
  }

  // ---------- Excel library (loaded on demand) ----------
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    xlsxLoading = xlsxLoading || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.onload = resolve;
      s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the Excel reader. Check your internet connection.')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  // ---------- Boot / auth ----------
  async function boot() {
    document.querySelectorAll('.brand-name').forEach(el => { el.textContent = cfg.COMPANY_NAME || 'Sales CRM'; });
    document.title = cfg.COMPANY_NAME || 'Sales CRM';
    if (api.mode === 'error') return showLogin(api.error);
    try {
      me = await api.init();
    } catch (e) {
      return showLogin(e.message);
    }
    if (me && me.active) return startApp();
    if (me) { await api.signOut(); return showLogin('This account has been deactivated.'); }
    showLogin();
  }

  function showLogin(err) {
    $('#appShell').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    $('#loginError').textContent = err || '';
    $('#demoHint').classList.toggle('hidden', api.mode !== 'demo');
    $('#loginBtn').disabled = api.mode === 'error';
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      me = await api.signIn(f.email.value, f.password.value);
      if (!me.active) { await api.signOut(); throw new Error('This account has been deactivated.'); }
      f.reset();
      startApp();
    } catch (err) {
      $('#loginError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  async function startApp() {
    filters = { q: '', status: '', fu: '', product: '', owner: '' };
    sort = { key: 'next_connect', asc: true };
    page = 0;
    selected.clear();
    pendingImport = null;
    $('#loginScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    $('#demoBanner').classList.toggle('hidden', api.mode !== 'demo');
    $('#meName').textContent = me.full_name || me.email;
    $('#meRole').textContent = isAdmin() ? 'Admin' : 'Employee';
    $('#view').innerHTML = '<p class="muted">Loading…</p>';
    await reload();
    go('dashboard');
  }

  async function reload() {
    await guard(async () => {
      [users, leads] = await Promise.all([api.listProfiles(), api.listLeads()]);
    });
  }

  // ---------- Navigation ----------
  function navItems() {
    const due = leads.filter(l => (fuState(l) === 'OVERDUE' || fuState(l) === 'TODAY') && (isAdmin() ? true : l.assigned_to === me.id)).length;
    const items = [
      ['dashboard', isAdmin() ? 'Admin dashboard' : 'My dashboard'],
      ['clients', isAdmin() ? 'All clients' : 'My clients'],
      ['followups', 'Follow-ups', due],
      ['upload', 'Bulk upload'],
    ];
    if (isAdmin()) items.push(['team', 'Team & users']);
    items.push(['account', 'My account']);
    return items;
  }

  function renderNav() {
    $('#nav').innerHTML = navItems().map(([id, label, badge]) =>
      `<button data-view="${id}" class="${id === view ? 'active' : ''}">${label}${badge ? ` <span class="badge">${badge}</span>` : ''}</button>`).join('');
  }

  function go(v) {
    view = v;
    renderNav();
    const fn = { dashboard: renderDashboard, clients: renderClients, followups: renderFollowups, upload: renderUpload, team: renderTeam, account: renderAccount }[v];
    if (v === 'team' && !isAdmin()) return go('dashboard');
    fn();
  }
  const rerender = () => go(view);

  // ---------- Dashboards ----------
  function kpi(label, value, cls = '') {
    return `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  }
  function bars(rows) {
    const max = Math.max(1, ...rows.map(r => r[1]));
    return rows.map(([label, n]) => `
      <div class="bar-row"><span>${esc(label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div>
        <span class="num">${n.toLocaleString('en-IN')}</span></div>`).join('');
  }
  function clientList(items, showOwner) {
    if (!items.length) return '<p class="muted">Nothing here.</p>';
    return items.map(l => `
      <div class="list-item" data-lead="${l.id}">
        <div><div class="li-title">${esc(l.client_name)}</div>
          <div class="sub">${esc(l.contact || '')}${l.next_action ? ' · ' + esc(l.next_action) : ''}${showOwner ? ' · ' + esc(userName(l.assigned_to)) : ''}</div></div>
        <div class="right">${statusPill(l.status)} ${fuPill(l)}<div class="sub">${fmtDate(l.next_connect)}</div></div>
      </div>`).join('');
  }

  async function renderDashboard() {
    const since7 = new Date(); since7.setDate(since7.getDate() - 6); since7.setHours(0, 0, 0, 0);
    $('#view').innerHTML = '<p class="muted">Loading…</p>';
    const acts = (await guard(() => api.listActivitiesSince(since7.toISOString()))) || [];
    if (view !== 'dashboard') return;
    const t = today();
    const actsToday = acts.filter(a => ymd(new Date(a.created_at)) === t);

    const mine = isAdmin() ? leads : leads.filter(l => l.assigned_to === me.id);
    const overdue = mine.filter(l => fuState(l) === 'OVERDUE').sort((a, b) => a.next_connect.localeCompare(b.next_connect));
    const dueToday = mine.filter(l => fuState(l) === 'TODAY');
    const stale = mine.filter(l => !CLOSED.includes(l.status) && (daysSince(l) ?? 9999) > 30);
    const count = s => mine.filter(l => l.status === s).length;

    let html = `<header class="view-head"><h1>${isAdmin() ? 'Admin dashboard' : 'My dashboard'}</h1>
      <button class="primary" data-action="new-lead">+ New client</button></header>
      <div class="stats">
        ${kpi(isAdmin() ? 'Total clients' : 'My clients', mine.length.toLocaleString('en-IN'))}
        ${kpi('Hot', count('Hot'), 'hot')}
        ${kpi('Converted', count('Converted'), 'ok')}
        ${kpi('Overdue follow-ups', overdue.length, overdue.length ? 'bad' : '')}
        ${kpi('Due today', dueToday.length, dueToday.length ? 'warn' : '')}
        ${kpi('Connects today', actsToday.length)}
        ${kpi('Connects (7 days)', acts.length)}
        ${kpi('Not contacted 30+ days', stale.length)}
      </div>`;

    if (isAdmin()) {
      const rows = activeUsers().map(u => {
        const ul = leads.filter(l => l.assigned_to === u.id);
        const ua = acts.filter(a => a.user_id === u.id);
        const last = ua.reduce((m, a) => a.created_at > m ? a.created_at : m, '');
        return { u, total: ul.length, hot: ul.filter(l => l.status === 'Hot').length, warm: ul.filter(l => l.status === 'Warm').length,
          cold: ul.filter(l => l.status === 'Cold').length, conv: ul.filter(l => l.status === 'Converted').length,
          over: ul.filter(l => fuState(l) === 'OVERDUE').length, today: ul.filter(l => fuState(l) === 'TODAY').length,
          ct: ua.filter(a => ymd(new Date(a.created_at)) === t).length, c7: ua.length, last };
      });
      const unassigned = leads.filter(l => !l.assigned_to || !users.some(u => u.id === l.assigned_to)).length;
      html += `<div class="card"><h2>Team performance</h2><div class="table-wrap flat"><table>
        <thead><tr><th>Team member</th><th class="num">Clients</th><th class="num">Hot</th><th class="num">Warm</th><th class="num">Cold</th>
          <th class="num">Converted</th><th class="num">Overdue</th><th class="num">Due today</th><th class="num">Connects today</th>
          <th class="num">Connects 7d</th><th>Last activity</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-owner="${esc(r.u.id)}">
          <td><div class="li-title">${esc(r.u.full_name || r.u.email)}</div><div class="sub">${r.u.role === 'admin' ? 'Admin' : 'Employee'}</div></td>
          <td class="num">${r.total}</td><td class="num">${r.hot}</td><td class="num">${r.warm}</td><td class="num">${r.cold}</td>
          <td class="num">${r.conv}</td><td class="num ${r.over ? 'overdue' : ''}">${r.over}</td><td class="num">${r.today}</td>
          <td class="num">${r.ct}</td><td class="num">${r.c7}</td><td class="sub">${r.last ? fmtDateTime(r.last) : '-'}</td></tr>`).join('')}
        </tbody></table></div>
        ${unassigned ? `<p class="muted">${unassigned} client(s) are unassigned. <a href="#" data-owner="__none">Assign them</a></p>` : ''}
        <p class="muted small-text">Click a row to see that person's clients.</p></div>`;
    }

    const statusRows = STATUSES.map(s => [s, count(s)]);
    const other = mine.filter(l => !STATUSES.includes(l.status)).length;
    if (other) statusRows.push(['Other', other]);
    html += `<div class="grid2">
      <div class="card"><h2>Clients by status</h2>${bars(statusRows)}</div>
      <div class="card"><h2>Product interest</h2>${bars([['PMS', mine.filter(l => l.pms).length], ['AIF', mine.filter(l => l.aif).length], ['MF', mine.filter(l => l.mf).length]])}</div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Overdue follow-ups <span class="muted">(${overdue.length})</span></h2>${clientList(overdue.slice(0, 10), isAdmin())}
        ${overdue.length > 10 ? `<button data-goto-fu="OVERDUE" class="small">See all ${overdue.length}</button>` : ''}</div>
      <div class="card"><h2>Due today <span class="muted">(${dueToday.length})</span></h2>${clientList(dueToday.slice(0, 10), isAdmin())}</div>
    </div>`;
    $('#view').innerHTML = html;
  }

  // ---------- Clients table ----------
  function filtered() {
    const q = filters.q.trim().toLowerCase();
    let rows = leads.filter(l =>
      (!filters.status || l.status === filters.status) &&
      (!filters.fu || fuState(l) === filters.fu || (filters.fu === 'NONE' && !fuState(l))) &&
      (!filters.product || l[filters.product]) &&
      (!filters.owner || (filters.owner === '__none' ? !l.assigned_to || !users.some(u => u.id === l.assigned_to) : l.assigned_to === filters.owner)) &&
      (!q || [l.client_name, l.contact, l.email, l.location, l.remark, l.products_pitched, l.next_action].join(' ').toLowerCase().includes(q)));
    const { key, asc } = sort;
    const val = l => key === 'days' ? (daysSince(l) ?? -1) : key === 'owner' ? userName(l.assigned_to) : (l[key] ?? '');
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      // empty dates go last regardless of direction
      if (x === '' && y !== '') return 1;
      if (y === '' && x !== '') return -1;
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
    return rows;
  }

  function renderClients() {
    const head = (key, label, cls = '') =>
      `<th data-sort="${key}" class="${cls} ${sort.key === key ? 'sorted' + (sort.asc ? ' asc' : '') : ''}">${label}</th>`;
    $('#view').innerHTML = `
      <header class="view-head"><h1>${isAdmin() ? 'All clients' : 'My clients'}</h1>
        <div class="row"><button data-action="export">Export to Excel</button><button class="primary" data-action="new-lead">+ New client</button></div></header>
      <div class="filters">
        <input id="fQ" type="search" placeholder="Search name, contact, email, location, remark…" value="${esc(filters.q)}">
        <select id="fStatus"><option value="">All statuses</option>${STATUSES.map(s => `<option ${s === filters.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="fFu"><option value="">All follow-ups</option>${['OVERDUE', 'TODAY', 'UPCOMING'].map(s => `<option value="${s}" ${s === filters.fu ? 'selected' : ''}>${s[0] + s.slice(1).toLowerCase()}</option>`).join('')}<option value="NONE" ${filters.fu === 'NONE' ? 'selected' : ''}>No date set</option></select>
        <select id="fProduct"><option value="">All products</option>${['pms', 'aif', 'mf'].map(p => `<option value="${p}" ${p === filters.product ? 'selected' : ''}>${p.toUpperCase()}</option>`).join('')}</select>
        ${isAdmin() ? `<select id="fOwner">${userOptions(filters.owner, { includeAll: true, includeUnassigned: true })}</select>` : ''}
      </div>
      <div id="bulkBar" class="bulk-bar hidden"></div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? '<th class="cb"><input type="checkbox" id="selAll" aria-label="Select all on page"></th>' : ''}
          ${head('client_name', 'Client')}${head('contact', 'Contact')}${head('location', 'Location')}${head('status', 'Status')}
          <th>Interest</th>${head('last_connected', 'Last connected')}${head('days', 'Days since', 'num')}${head('next_connect', 'Next connect')}
          <th>Follow up</th>${isAdmin() ? head('owner', 'Assigned to') : ''}
        </tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <div class="pager" id="pager"></div>`;
    if (isAdmin() && filters.owner) $('#fOwner').value = filters.owner;
    renderRows();
  }

  function renderRows() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const cols = isAdmin() ? 11 : 9;
    $('#rows').innerHTML = slice.length ? slice.map(l => {
      const ds = daysSince(l);
      return `<tr data-lead="${l.id}">
        ${isAdmin() ? `<td class="cb"><input type="checkbox" data-sel="${l.id}" ${selected.has(l.id) ? 'checked' : ''}></td>` : ''}
        <td><div class="li-title">${esc(l.client_name)}</div>${l.email ? `<div class="sub">${esc(l.email)}</div>` : ''}</td>
        <td>${esc(l.contact)}</td>
        <td>${esc(l.location)}</td>
        <td>${statusPill(l.status)}</td>
        <td>${products(l)}</td>
        <td>${fmtDate(l.last_connected)}</td>
        <td class="num ${ds > 30 ? 'overdue' : ''}">${ds ?? ''}</td>
        <td>${fmtDate(l.next_connect)}</td>
        <td>${fuPill(l)}</td>
        ${isAdmin() ? `<td class="sub">${esc(userName(l.assigned_to))}</td>` : ''}
      </tr>`;
    }).join('') : `<tr><td colspan="${cols}" class="empty">No clients found. Add one, or use Bulk upload.</td></tr>`;

    $('#pager').innerHTML = `<span class="muted">${rows.length.toLocaleString('en-IN')} clients · page ${page + 1} of ${pages}</span>
      <button data-page="-1" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <button data-page="1" ${page >= pages - 1 ? 'disabled' : ''}>Next ›</button>`;
    if ($('#selAll')) $('#selAll').checked = slice.length > 0 && slice.every(l => selected.has(l.id));
    renderBulkBar(rows);
  }

  function renderBulkBar(rows) {
    const bar = $('#bulkBar');
    if (!bar) return;
    if (!isAdmin() || !selected.size) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = `<strong>${selected.size} selected</strong>
      <button class="small" data-action="select-all-filtered">Select all ${rows.length} matching</button>
      <button class="small" data-action="clear-selection">Clear</button>
      <span class="spacer"></span>
      <select id="bulkAssignTo">${userOptions(null)}</select>
      <button class="small primary" data-action="bulk-assign">Assign</button>
      <button class="small danger" data-action="bulk-delete">Delete</button>`;
  }

  // ---------- Follow-ups ----------
  function renderFollowups() {
    const mine = isAdmin() ? leads : leads.filter(l => l.assigned_to === me.id);
    const t = today();
    const in7 = new Date(); in7.setDate(in7.getDate() + 7);
    const by = s => mine.filter(l => fuState(l) === s).sort((a, b) => a.next_connect.localeCompare(b.next_connect));
    const upcoming = by('UPCOMING').filter(l => l.next_connect <= ymd(in7));
    const stale = mine.filter(l => !CLOSED.includes(l.status) && !l.next_connect).slice(0, 50);
    $('#view').innerHTML = `<header class="view-head"><h1>Follow-ups</h1><span class="muted">${fmtDate(t)}</span></header>
      <div class="card"><h2 class="overdue">Overdue (${by('OVERDUE').length})</h2>${clientList(by('OVERDUE'), isAdmin())}</div>
      <div class="card"><h2 class="today">Today (${by('TODAY').length})</h2>${clientList(by('TODAY'), isAdmin())}</div>
      <div class="card"><h2>Next 7 days (${upcoming.length})</h2>${clientList(upcoming, isAdmin())}</div>
      <div class="card"><h2>No next connect date set</h2><p class="muted small-text">Open clients without a follow-up date (first 50).</p>${clientList(stale, isAdmin())}</div>`;
  }

  // ---------- Client dialog ----------
  const dialog = $('#leadDialog');
  const form = $('#leadForm');
  $('#actType').innerHTML = ACT_TYPES.map(t => `<option>${t}</option>`).join('');

  function openLead(id) {
    editing = id ? leads.find(l => l.id === id) : null;
    if (id && !editing) return;
    const l = editing || { status: 'New', assigned_to: me.id };
    form.reset();
    const statuses = STATUSES.includes(l.status) || !l.status ? STATUSES : [...STATUSES, l.status];
    form.status.innerHTML = statuses.map(s => `<option ${s === l.status ? 'selected' : ''}>${esc(s)}</option>`).join('');
    form.assigned_to.innerHTML = `<option value="">Unassigned</option>` + userOptions(l.assigned_to);
    $('#assignWrap').classList.toggle('hidden', !isAdmin());
    for (const k of ['client_name', 'contact', 'email', 'location', 'products_pitched', 'last_connected', 'next_connect', 'next_action', 'remark']) {
      form[k].value = l[k] ?? '';
    }
    for (const k of ['pms', 'aif', 'mf']) form[k].checked = !!l[k];
    form.assigned_to.value = l.assigned_to || '';
    $('#leadTitle').textContent = editing ? editing.client_name : 'New client';
    $('#activityBox').classList.toggle('hidden', !editing);
    $('#deleteLeadBtn').classList.toggle('hidden', !(editing && isAdmin()));
    $('#actNote').value = ''; $('#actNext').value = '';
    $('#activityList').innerHTML = '';
    dialog.showModal();
    if (editing) loadActivities(editing.id);
  }

  async function loadActivities(id) {
    $('#activityList').innerHTML = '<li class="muted">Loading…</li>';
    const acts = await guard(() => api.listActivities(id)) || [];
    if (!editing || editing.id !== id) return;
    $('#activityList').innerHTML = acts.length ? acts.map(a => `
      <li><div>${esc(a.note || '')}</div>
        <div class="act-meta">${esc(a.type)} · ${esc(userName(a.user_id))} · ${fmtDateTime(a.created_at)}</div></li>`).join('')
      : '<li class="muted">No connects logged yet.</li>';
  }

  function formData() {
    const d = {};
    for (const k of ['client_name', 'contact', 'email', 'location', 'status', 'products_pitched', 'last_connected', 'next_connect', 'next_action', 'remark']) {
      d[k] = form[k].value.trim();
    }
    for (const k of ['pms', 'aif', 'mf']) d[k] = form[k].checked;
    d.assigned_to = isAdmin() ? (form.assigned_to.value || null) : (editing ? editing.assigned_to : me.id);
    return d;
  }

  function upsertLocal(saved) {
    const i = leads.findIndex(l => l.id === saved.id);
    if (i >= 0) leads[i] = saved; else leads.push(saved);
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formData();
    if (!d.client_name) return toast('Client name is required', true);
    const saved = await guard(() => api.saveLead(editing ? { ...d, id: editing.id } : d));
    if (!saved) return;
    upsertLocal(saved);
    dialog.close();
    toast(editing ? 'Client updated' : 'Client added');
    rerender();
  });

  async function logActivity() {
    if (!editing) return;
    const note = $('#actNote').value.trim();
    if (!note) return toast('Write what was discussed first', true);
    const next = $('#actNext').value;
    const act = await guard(() => api.addActivity({ lead_id: editing.id, type: $('#actType').value, note }));
    if (!act) return;
    // Also save any unsaved edits in the form, plus the connect dates
    const d = formData();
    d.last_connected = today();
    if (next) d.next_connect = next;
    const saved = await guard(() => api.saveLead({ ...d, id: editing.id }));
    if (saved) {
      upsertLocal(saved);
      editing = saved;
      form.last_connected.value = saved.last_connected || '';
      form.next_connect.value = saved.next_connect || '';
    }
    $('#actNote').value = ''; $('#actNext').value = '';
    toast('Connect logged');
    loadActivities(editing.id);
    renderNav();
  }

  // ---------- Bulk upload ----------
  // Header aliases (normalised: lowercase, letters/digits only). Matches the team sheet and common variants.
  const COLS = {
    client_name: ['clientname', 'client', 'name', 'customername', 'companyname', 'company', 'fullname'],
    location: ['location', 'city', 'area', 'industrialarea', 'address'],
    email: ['emailid', 'email', 'mail', 'emailaddress'],
    contact: ['contact', 'contactno', 'contactnumber', 'phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno'],
    remark: ['remark', 'remarks', 'notes', 'note', 'comments'],
    status: ['status', 'leadstatus'],
    pms: ['pms'], aif: ['aif'], mf: ['mf', 'mutualfund', 'mutualfunds'],
    last_connected: ['lastconnected', 'lastcontacted', 'lastconnect', 'lastcall'],
    next_action: ['nextaction'],
    next_connect: ['nextconnect', 'nextfollowup', 'followupdate', 'nextcall', 'nextconnectdate'],
    products_pitched: ['productspitched', 'productpitched', 'products', 'pitched', 'schemes', 'schemespitched'],
    owner: ['assignedto', 'owner', 'rm', 'employee', 'salesperson'],
  };
  const norm = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const yes = v => /^(y|yes|true|1|✓|✔)$/i.test(String(v ?? '').trim());

  function toISODate(v) {
    if (v === '' || v == null) return null;
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
      return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    if (v instanceof Date && !isNaN(v)) return ymd(v);
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // Indian format dd/mm/yyyy
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
    const t = Date.parse(s);
    return isNaN(t) ? null : ymd(new Date(t));
  }

  function normStatus(v) {
    const s = String(v ?? '').trim();
    if (!s) return 'New';
    return STATUSES.find(x => x.toLowerCase() === s.toLowerCase()) || s;
  }

  function findUser(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    return users.find(u => u.email.toLowerCase() === s || (u.full_name || '').toLowerCase() === s) || null;
  }

  async function parseFile(file) {
    await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    // Header = first row that has a recognisable client name column
    const hi = grid.findIndex(r => r.some(h => COLS.client_name.includes(norm(h))));
    if (hi < 0) throw new Error(`${file.name}: could not find a "Client_Name" (or "Name") column.`);
    const headers = grid[hi].map(norm);
    const col = {};
    for (const [field, names] of Object.entries(COLS)) {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) { col[field] = i; break; }
      }
    }
    const body = grid.slice(hi + 1);
    // The team sheet keeps products pitched in a column with no header
    if (col.products_pitched == null) {
      const i = headers.findIndex((h, idx) => h === '' && body.some(r => String(r[idx] ?? '').trim()));
      if (i >= 0) col.products_pitched = i;
    }
    const get = (r, f) => col[f] == null ? '' : r[col[f]];
    const str = (r, f) => String(get(r, f) ?? '').trim();
    const rows = [];
    for (const r of body) {
      const name = str(r, 'client_name');
      if (!name) continue;
      const row = {
        client_name: name,
        location: str(r, 'location'),
        email: str(r, 'email'),
        contact: str(r, 'contact'),
        remark: str(r, 'remark'),
        status: normStatus(get(r, 'status')),
        pms: yes(get(r, 'pms')), aif: yes(get(r, 'aif')), mf: yes(get(r, 'mf')),
        products_pitched: str(r, 'products_pitched'),
        last_connected: toISODate(get(r, 'last_connected')),
        next_action: str(r, 'next_action'),
        next_connect: toISODate(get(r, 'next_connect')),
        _owner: str(r, 'owner'),
      };
      // Email typed into the Location column by mistake
      if (!row.email && /^\S+@\S+\.\S+$/.test(row.location)) { row.email = row.location; row.location = ''; }
      rows.push(row);
    }
    return { rows, mapped: Object.keys(col) };
  }

  function renderUpload() {
    $('#view').innerHTML = `<header class="view-head"><h1>Bulk upload</h1>
        <button data-action="template">Download Excel template</button></header>
      <div class="card">
        <h2>1. Choose your Excel or CSV files</h2>
        <p class="muted">Use the same sheet your team already maintains (Client_Name, Location, Email id, Contact, Remark, Status, PMS, AIF, MF, Last connected, Next_Action, Next Connect…).
          The first sheet is read. "Day Since Contacted" and "Follow ups" are calculated automatically, so you don't need to fill them in.</p>
        <div class="row">
          <input type="file" id="upFile" accept=".xlsx,.xls,.csv" multiple>
          ${isAdmin() ? `<label class="inline">Assign to <select id="upOwner">${userOptions(me.id)}</select></label>` : ''}
        </div>
        ${isAdmin() ? '<p class="muted small-text">If the sheet has an "Assigned To" column with a team member\'s name or email, that is used instead.</p>' : ''}
        <label class="check"><input type="checkbox" id="upSkipDup" checked> Skip clients whose contact number already exists</label>
      </div>
      <div id="upPreview"></div>`;
    pendingImport = null;
  }

  async function handleUploadFiles(files) {
    const box = $('#upPreview');
    box.innerHTML = '<div class="card"><p class="muted">Reading files…</p></div>';
    try {
      const all = [];
      const notes = [];
      for (const f of files) {
        const { rows, mapped } = await parseFile(f);
        all.push(...rows);
        notes.push(`${esc(f.name)}: ${rows.length} rows · columns found: ${mapped.map(esc).join(', ')}`);
      }
      const existing = new Set(leads.map(l => phoneKey(l.contact)).filter(Boolean));
      const seen = new Set();
      for (const r of all) {
        const k = phoneKey(r.contact);
        r._dup = !!k && (existing.has(k) || seen.has(k));
        if (k) seen.add(k);
      }
      pendingImport = all;
      const dups = all.filter(r => r._dup).length;
      box.innerHTML = `<div class="card">
        <h2>2. Check and import</h2>
        <p>${notes.join('<br>')}</p>
        <p><strong>${all.length}</strong> clients found · <strong>${dups}</strong> duplicate contact numbers</p>
        <div class="table-wrap flat"><table><thead><tr><th>Client</th><th>Contact</th><th>Location</th><th>Status</th><th>Interest</th>
          <th>Last connected</th><th>Next connect</th><th>Products pitched</th><th></th></tr></thead>
          <tbody>${all.slice(0, 15).map(r => `<tr><td>${esc(r.client_name)}<div class="sub">${esc(r.email)}</div></td><td>${esc(r.contact)}</td>
            <td>${esc(r.location)}</td><td>${statusPill(r.status)}</td><td>${products(r)}</td><td>${fmtDate(r.last_connected)}</td>
            <td>${fmtDate(r.next_connect)}</td><td>${esc(r.products_pitched)}</td><td>${r._dup ? '<span class="fu fu-overdue">DUPLICATE</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
        ${all.length > 15 ? `<p class="muted small-text">Showing the first 15 of ${all.length}.</p>` : ''}
        <div class="row" style="margin-top:12px"><button class="primary" data-action="do-import">Import clients</button>
          <button data-action="cancel-import">Cancel</button></div>
      </div>`;
    } catch (e) {
      box.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
    }
  }

  async function doImport() {
    if (!pendingImport) return;
    const total = pendingImport.length;
    const skipDup = $('#upSkipDup').checked;
    const def = isAdmin() ? $('#upOwner').value : me.id;
    let unknownOwners = 0;
    const rows = pendingImport.filter(r => !(skipDup && r._dup)).map(({ _dup, _owner, ...r }) => {
      let owner = def;
      if (isAdmin() && _owner) {
        const u = findUser(_owner);
        if (u) owner = u.id; else unknownOwners++;
      }
      return { ...r, assigned_to: owner };
    });
    if (!rows.length) return toast('Nothing to import: every row is a duplicate.', true);
    const btn = document.querySelector('[data-action="do-import"]');
    btn.disabled = true; btn.textContent = `Importing ${rows.length}…`;
    const n = await guard(() => api.insertLeads(rows));
    if (n == null) { btn.disabled = false; btn.textContent = 'Import clients'; return; }
    await reload();
    pendingImport = null;
    $('#upPreview').innerHTML = `<div class="card"><p><strong>${n}</strong> clients imported${skipDup ? `, ${total - rows.length} duplicates skipped` : ''}.
      ${unknownOwners ? `<br><span class="muted">${unknownOwners} rows had an "Assigned To" name that didn't match a team member, so they were assigned to the default person.</span>` : ''}</p>
      <button data-view-go="clients">View clients</button></div>`;
    renderNav();
  }

  async function downloadTemplate() {
    await guard(async () => {
      await loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet([
        SHEET_HEADERS.filter(h => !['Day Since Contacted', 'Follow ups'].includes(h)),
        [1, 'Sample Client', 'Mumbai', 'client@example.com', '9876543210', 'Interested in PMS, call next week', 'Hot', 'Y', '', 'Y',
          today(), 'Share factsheet', today(), 'Stallion', me.full_name || me.email],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Clients');
      XLSX.writeFile(wb, 'crm-upload-template.xlsx');
    });
  }

  async function exportExcel() {
    await guard(async () => {
      await loadXlsx();
      const rows = filtered().map((l, i) => [i + 1, l.client_name, l.location || '', l.email || '', l.contact || '', l.remark || '', l.status || '',
        l.pms ? 'Y' : '', l.aif ? 'Y' : '', l.mf ? 'Y' : '', l.last_connected || '', l.next_action || '', l.next_connect || '',
        l.products_pitched || '', daysSince(l) ?? '', fuState(l), userName(l.assigned_to)]);
      const ws = XLSX.utils.aoa_to_sheet([SHEET_HEADERS, ...rows]);
      ws['!cols'] = SHEET_HEADERS.map(h => ({ wch: h === 'Remark' ? 50 : Math.max(12, h.length + 2) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Clients');
      XLSX.writeFile(wb, `clients-${today()}.xlsx`);
    });
  }

  // ---------- Team (admin) ----------
  function renderTeam() {
    const count = id => leads.filter(l => l.assigned_to === id).length;
    $('#view').innerHTML = `<header class="view-head"><h1>Team &amp; users</h1></header>
      <div class="card">
        <h2>Create a login</h2>
        <form id="newUserForm" class="form-grid four">
          <label>Full name<input name="full_name" required></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Temporary password<input name="password" type="text" minlength="6" required></label>
          <label>Role<select name="role"><option value="employee">Employee</option><option value="admin">Admin</option></select></label>
          <div class="span-all row"><button class="primary" type="submit">Create user</button>
            <span class="muted small-text">Share the email and password with the employee. They can change the password under "My account".</span></div>
        </form>
      </div>
      <div class="card"><h2>Users (${users.length})</h2><div class="table-wrap flat"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="num">Clients</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td class="li-title">${esc(u.full_name || '-')}</td><td>${esc(u.email)}</td>
          <td>${u.id === me.id ? 'Admin (you)' : `<select data-role="${esc(u.id)}"><option value="employee" ${u.role === 'employee' ? 'selected' : ''}>Employee</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select>`}</td>
          <td class="num">${count(u.id)}</td>
          <td>${u.active ? '<span class="pill st-converted">Active</span>' : '<span class="pill st-not-interested">Deactivated</span>'}</td>
          <td class="sub">${fmtDate(u.created_at)}</td>
          <td>${u.id === me.id ? '' : `<button class="small ${u.active ? 'danger' : ''}" data-toggle-user="${esc(u.id)}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}</td>
        </tr>`).join('')}</tbody></table></div>
        <p class="muted small-text">Deactivated users can't sign in or see any data. To pass their clients to someone else, filter "All clients" by their name, select all, and use Assign.</p>
      </div>`;
    $('#newUserForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const data = { full_name: f.full_name.value.trim(), email: f.email.value.trim(), password: f.password.value, role: f.role.value };
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      const ok = await guard(async () => { await api.createUser(data); return true; });
      btn.disabled = false;
      if (!ok) return;
      toast(`Login created for ${data.full_name}`);
      users = await guard(() => api.listProfiles()) || users;
      renderTeam();
    });
  }

  // ---------- Account ----------
  function renderAccount() {
    $('#view').innerHTML = `<header class="view-head"><h1>My account</h1></header>
      <div class="card"><p><strong>${esc(me.full_name || '')}</strong><br>${esc(me.email)}<br><span class="muted">${isAdmin() ? 'Admin' : 'Employee'}</span></p></div>
      <div class="card"><h2>Change password</h2>
        <form id="pwForm" class="row">
          <input name="pw" type="password" minlength="6" placeholder="New password (min 6 characters)" required autocomplete="new-password" style="max-width:300px">
          <button class="primary" type="submit">Update password</button>
        </form></div>`;
    $('#pwForm').addEventListener('submit', async e => {
      e.preventDefault();
      const ok = await guard(async () => { await api.changePassword(e.target.pw.value); return true; });
      if (ok) { e.target.reset(); toast('Password updated'); }
    });
  }

  // ---------- Events ----------
  document.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('dialog') && !t.closest('[data-action]')) return;

    const nav = t.closest('[data-view]');
    if (nav) return go(nav.dataset.view);
    const goBtn = t.closest('[data-view-go]');
    if (goBtn) return go(goBtn.dataset.viewGo);

    const owner = t.closest('[data-owner]');
    if (owner) {
      e.preventDefault();
      filters = { q: '', status: '', fu: '', product: '', owner: owner.dataset.owner };
      page = 0;
      return go('clients');
    }
    const fuBtn = t.closest('[data-goto-fu]');
    if (fuBtn) { filters = { ...filters, fu: fuBtn.dataset.gotoFu, owner: '' }; page = 0; return go('clients'); }

    if (t.matches('[data-sel]')) {
      const id = Number(t.dataset.sel) || t.dataset.sel;
      t.checked ? selected.add(id) : selected.delete(id);
      return renderRows();
    }
    if (t.id === 'selAll') {
      const slice = filtered().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      slice.forEach(l => t.checked ? selected.add(l.id) : selected.delete(l.id));
      return renderRows();
    }
    if (t.closest('td.cb')) return;

    const th = t.closest('th[data-sort]');
    if (th) {
      sort = sort.key === th.dataset.sort ? { key: sort.key, asc: !sort.asc } : { key: th.dataset.sort, asc: true };
      return renderClients();
    }
    const pg = t.closest('[data-page]');
    if (pg) { page += Number(pg.dataset.page); return renderRows(); }

    const toggle = t.closest('[data-toggle-user]');
    if (toggle) {
      const u = users.find(x => x.id === toggle.dataset.toggleUser);
      if (u.active && !confirm(`Deactivate ${u.full_name || u.email}? They will no longer be able to sign in.`)) return;
      const ok = await guard(async () => { await api.updateProfile(u.id, { active: !u.active }); return true; });
      if (ok) { u.active = !u.active; renderTeam(); }
      return;
    }

    const leadRow = t.closest('[data-lead]');
    if (leadRow) return openLead(Number(leadRow.dataset.lead) || leadRow.dataset.lead);

    const action = t.closest('[data-action]')?.dataset.action;
    switch (action) {
      case 'new-lead': return openLead(null);
      case 'close-dialog': return dialog.close();
      case 'log-activity': return logActivity();
      case 'delete-lead':
        if (editing && confirm(`Delete ${editing.client_name} permanently?`)) {
          const ok = await guard(async () => { await api.deleteLeads([editing.id]); return true; });
          if (ok) { leads = leads.filter(l => l.id !== editing.id); dialog.close(); toast('Client deleted'); rerender(); }
        }
        return;
      case 'sign-out':
        await api.signOut();
        me = null; leads = []; users = []; selected.clear();
        return showLogin();
      case 'export': return exportExcel();
      case 'template': return downloadTemplate();
      case 'do-import': return doImport();
      case 'cancel-import': pendingImport = null; $('#upPreview').innerHTML = ''; $('#upFile').value = ''; return;
      case 'select-all-filtered': filtered().forEach(l => selected.add(l.id)); return renderRows();
      case 'clear-selection': selected.clear(); return renderRows();
      case 'bulk-assign': {
        const uid = $('#bulkAssignTo').value;
        const ids = [...selected];
        if (!confirm(`Assign ${ids.length} clients to ${userName(uid)}?`)) return;
        const ok = await guard(async () => { await api.assignLeads(ids, uid); return true; });
        if (ok) {
          const s = new Set(ids);
          leads.forEach(l => { if (s.has(l.id)) l.assigned_to = uid; });
          selected.clear(); toast(`${ids.length} clients assigned to ${userName(uid)}`); renderRows();
        }
        return;
      }
      case 'bulk-delete': {
        const ids = [...selected];
        if (!confirm(`Permanently delete ${ids.length} clients and their history?`)) return;
        const ok = await guard(async () => { await api.deleteLeads(ids); return true; });
        if (ok) {
          const s = new Set(ids);
          leads = leads.filter(l => !s.has(l.id));
          selected.clear(); toast(`${ids.length} clients deleted`); renderRows();
        }
        return;
      }
    }
  });

  document.addEventListener('input', e => {
    const id = e.target.id;
    const map = { fQ: 'q', fStatus: 'status', fFu: 'fu', fProduct: 'product', fOwner: 'owner' };
    if (map[id]) { filters[map[id]] = e.target.value; page = 0; renderRows(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'upFile' && e.target.files.length) handleUploadFiles([...e.target.files]);
    const roleSel = e.target.closest('[data-role]');
    if (roleSel) {
      const u = users.find(x => x.id === roleSel.dataset.role);
      guard(async () => { await api.updateProfile(u.id, { role: roleSel.value }); u.role = roleSel.value; toast('Role updated'); });
    }
  });
  $('#actNote').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); logActivity(); } });

  // Theme
  try {
    const th = localStorage.getItem('salesCrm.theme');
    if (th) document.documentElement.dataset.theme = th;
  } catch (e) { /* storage unavailable */ }
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('salesCrm.theme', next); } catch (e) { /* ignore */ }
  });

  boot();
})();
