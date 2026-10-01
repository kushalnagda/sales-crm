// Data layer. Two interchangeable backends with the same methods:
//  - supabaseApi: shared online database with real logins (used when config.js is filled in)
//  - demoApi: everything in this browser's localStorage, for trying the app out
window.CRM_API = (() => {
  'use strict';
  const cfg = window.CRM_CONFIG || {};
  const isDemo = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.startsWith('YOUR_') || /[?&]demo\b/.test(location.search);

  const LEAD_FIELDS = ['client_name', 'location', 'email', 'contact', 'remark', 'status', 'pms', 'aif', 'mf',
    'products_pitched', 'last_connected', 'next_action', 'next_connect', 'assigned_to'];
  const clean = l => Object.fromEntries(LEAD_FIELDS.filter(k => k in l).map(k => [k, l[k] === '' ? null : l[k]]));
  const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const nowIso = () => new Date().toISOString();

  // ------------------------------------------------------------------ Supabase
  function supabaseApi() {
    if (!window.supabase) throw new Error('Could not load the Supabase library. Check your internet connection.');
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const chk = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

    async function fetchAll(build) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const rows = chk(await build().range(from, from + 999));
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    }

    async function profile() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      const p = chk(await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
      if (!p) throw new Error('No profile found for this login. Ask your admin to create your account.');
      return p;
    }

    return {
      mode: 'supabase',
      init: profile,
      async signIn(email, password) {
        chk(await sb.auth.signInWithPassword({ email: email.trim(), password }));
        return profile();
      },
      async signOut() { await sb.auth.signOut(); },
      async changePassword(password) { chk(await sb.auth.updateUser({ password })); },
      // First-time setup: the database only allows this for User IDs an admin has approved
      async activate(email, password) {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw new Error(error.message);
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('This User ID is already active. Sign in instead.');
        }
        if (!data.session) throw new Error('Account created, but "Confirm email" is switched on in Supabase. Turn it off, then sign in.');
        return profile();
      },

      async listProfiles() { return chk(await sb.from('profiles').select('*').order('full_name')); },
      async updateProfile(id, patch) { chk(await sb.from('profiles').update(patch).eq('id', id)); },
      async createUser({ full_name, email, password, role }) {
        email = email.trim().toLowerCase();
        chk(await sb.from('allowed_users').upsert({ email, full_name, role }));
        // Separate client so the admin stays logged in while the new account is created
        const tmp = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'crm-signup-tmp' },
        });
        const { data, error } = await tmp.auth.signUp({ email, password });
        if (error) {
          // Don't leave an approved-but-unclaimed User ID behind
          await sb.from('allowed_users').delete().eq('email', email);
          throw new Error(error.message);
        }
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('A login with this User ID already exists.');
        }
      },

      listLeads: () => fetchAll(() => sb.from('leads').select('*').order('id')),
      async saveLead(l) {
        const row = clean(l);
        if (l.id) return chk(await sb.from('leads').update(row).eq('id', l.id).select().single());
        return chk(await sb.from('leads').insert(row).select().single());
      },
      async insertLeads(rows) {
        let n = 0;
        for (const c of chunks(rows.map(clean), 500)) { chk(await sb.from('leads').insert(c)); n += c.length; }
        return n;
      },
      async deleteLeads(ids) {
        for (const c of chunks(ids, 200)) chk(await sb.from('leads').delete().in('id', c));
      },
      async assignLeads(ids, userId) {
        for (const c of chunks(ids, 200)) chk(await sb.from('leads').update({ assigned_to: userId }).in('id', c));
      },

      async listActivities(leadId) {
        return chk(await sb.from('activities').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }));
      },
      listActivitiesSince: iso => fetchAll(() =>
        sb.from('activities').select('id,lead_id,user_id,type,created_at').gte('created_at', iso).order('id')),
      async addActivity(a) { return chk(await sb.from('activities').insert(a).select().single()); },
    };
  }

  // ------------------------------------------------------------------ Demo
  function demoApi() {
    const KEY = 'salesCrmDemo.v2';
    const seed = () => ({
      seq: 1000,
      session: null,
      users: [
        { id: 'u-admin', email: 'admin@demo.com', password: 'admin123', full_name: 'Demo Admin', role: 'admin', active: true, created_at: nowIso() },
        { id: 'u-emp1', email: 'employee@demo.com', password: 'emp123', full_name: 'Demo Employee', role: 'employee', active: true, created_at: nowIso() },
      ],
      leads: [],
      activities: [],
    });
    let d;
    try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.users)) d = seed();
    const persist = () => {
      try { localStorage.setItem(KEY, JSON.stringify(d)); }
      catch (e) { throw new Error('Browser storage is full.'); }
    };
    const me = () => d.users.find(u => u.id === d.session && u.active);
    const pub = ({ password, ...u }) => ({ ...u });
    const isAdmin = () => me()?.role === 'admin';
    const canSee = l => { const u = me(); return !!u && (u.role === 'admin' || l.assigned_to === u.id); };
    const need = ok => { if (!ok) throw new Error('Not allowed'); };
    const delay = v => new Promise(r => setTimeout(() => r(v), 30));

    function insertOne(l) {
      const u = me();
      const row = { ...clean(l), id: ++d.seq, created_by: u.id, created_at: nowIso(), updated_at: nowIso() };
      if (!row.assigned_to || u.role !== 'admin') row.assigned_to = u.id;
      d.leads.push(row);
      return row;
    }

    return {
      mode: 'demo',
      async init() { return delay(me() ? pub(me()) : null); },
      async signIn(email, password) {
        const u = d.users.find(x => x.email === email.trim().toLowerCase() && x.password === password);
        if (!u) throw new Error('Invalid login credentials');
        if (!u.active) throw new Error('This account has been deactivated.');
        d.session = u.id; persist();
        return pub(u);
      },
      async signOut() { d.session = null; persist(); },
      async changePassword(p) { need(me()); me().password = p; persist(); },
      async activate() { throw new Error('First-time setup is only available in the live version.'); },

      async listProfiles() { need(me()); return d.users.map(pub); },
      async updateProfile(id, patch) {
        need(isAdmin());
        Object.assign(d.users.find(u => u.id === id), patch); persist();
      },
      async createUser({ full_name, email, password, role }) {
        need(isAdmin());
        email = email.trim().toLowerCase();
        if (d.users.some(u => u.email === email)) throw new Error('A login with this User ID already exists.');
        d.users.push({ id: 'u-' + (++d.seq), email, password, full_name, role, active: true, created_at: nowIso() });
        persist();
      },

      async listLeads() { return delay(d.leads.filter(canSee).map(l => ({ ...l }))); },
      async saveLead(l) {
        need(me());
        if (!l.id) { const row = insertOne(l); persist(); return { ...row }; }
        const cur = d.leads.find(x => x.id === l.id);
        need(cur && canSee(cur));
        const patch = clean(l);
        if (!isAdmin()) patch.assigned_to = cur.assigned_to;
        Object.assign(cur, patch, { updated_at: nowIso() });
        persist();
        return { ...cur };
      },
      async insertLeads(rows) { need(me()); rows.forEach(insertOne); persist(); return rows.length; },
      async deleteLeads(ids) {
        need(isAdmin());
        const s = new Set(ids);
        d.leads = d.leads.filter(l => !s.has(l.id));
        d.activities = d.activities.filter(a => !s.has(a.lead_id));
        persist();
      },
      async assignLeads(ids, userId) {
        need(isAdmin());
        const s = new Set(ids);
        d.leads.forEach(l => { if (s.has(l.id)) { l.assigned_to = userId; l.updated_at = nowIso(); } });
        persist();
      },

      async listActivities(leadId) {
        const l = d.leads.find(x => x.id === leadId);
        need(l && canSee(l));
        return d.activities.filter(a => a.lead_id === leadId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      },
      async listActivitiesSince(iso) {
        const visible = new Set(d.leads.filter(canSee).map(l => l.id));
        return d.activities.filter(a => a.created_at >= iso && visible.has(a.lead_id));
      },
      async addActivity(a) {
        const l = d.leads.find(x => x.id === a.lead_id);
        need(l && canSee(l));
        const row = { ...a, id: ++d.seq, user_id: me().id, created_at: nowIso() };
        d.activities.push(row); persist();
        return row;
      },
    };
  }

  try {
    return isDemo ? demoApi() : supabaseApi();
  } catch (e) {
    return { mode: 'error', error: e.message };
  }
})();
