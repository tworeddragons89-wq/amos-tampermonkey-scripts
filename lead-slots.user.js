// ==UserScript==
// @name         Amos Lead Slots
// @namespace    amos-exteriors-lead-table
// @version      1.4.1
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/lead-slots.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/lead-slots.user.js
// @description  GroupMe board of confirmable lead slots (next 3 days starting tomorrow, Morning / Afternoon / Evening) from Lead Table 2026. Click a slot to mark it TAKEN on the Lead Table. Tampermonkey only - keep Lead Table 2026 open in another tab.
// @author       Andrew Thomas (Mars 2) with Claude
// @match        https://web.groupme.com/*
// @match        https://app.groupme.com/*
// @match        https://docs.google.com/spreadsheets/d/170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @connect      docs.google.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS (Tampermonkey only, no Google setup)
  - On GroupMe: a navy "Lead Slots" button. Click it to load the counts from Lead Table 2026.
  - Click a slot once to select it, click again to take it.
  - When you take a slot, Lead Table 2026 opens in a new tab for a few seconds, this same script types the red
    "TAKEN" there, and the tab closes by itself. (Chrome does not let scripts type into a tab in the background.)
*/
(function () {
  'use strict';

  const SSID = '170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY';   // Lead Table 2026
  const REP_COLS = 'CDEFGHIJKLMNOPQRSTUVW'.split('');
  const SLOT_NAMES = ['Morning', 'Afternoon', 'Evening'];
  const SKIP_TEXT = /^(DO NOT FILL|SALES MTG|NO LEADS|CANCELS?|PGT.*)$/i;
  const PATRICK_BLUE = '#0000ff';
  const MAX_ROW = 100;
  // Service-area territories shown as small counts under each slot. Names = first words on the names row.
  // The text color is taken from that rep's name cell on the Lead Table (falls back to the color here).
  const TERRITORIES = [
    { key: 'laf', label: 'Laf', reps: ['duke', 'dakota', 'pat howard'], color: '#ff9900' },
    { key: 'louis', label: 'Louis', reps: ['patrick murphy'], color: '#0000ff' },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const decode = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const normHex = (c) => { c = String(c || '').trim().toLowerCase(); const m = c.match(/^#([0-9a-f]{3})$/); return m ? '#' + m[1].split('').map((x) => x + x).join('') : c; };

  // ---------------- shared: read Lead Table 2026 ----------------
  function gmGet(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, timeout: 30000,
      onload: (r) => (r.status >= 400 ? reject(new Error(`Lead Table answered ${r.status}. Sign in to Google in this Chrome.`)) : resolve(r.responseText || '')),
      onerror: () => reject(new Error('Could not reach the Lead Table.')), ontimeout: () => reject(new Error('The Lead Table took too long to answer.'))
    }));
  }
  function parseSheet(html) {
    const styles = {};
    html.replace(/\.(s\d+)\s*\{([^}]*)\}/g, (m, cls, body) => { styles[cls] = normHex((body.match(/background-color:\s*([^;]+)/i) || [])[1]); return m; });
    const vis = []; const he = html.indexOf('</thead>');
    (he > 0 ? html.slice(0, he) : '').replace(/<th\b[^>]*id="[^"]*C(\d+)"[^>]*>/gi, (m, n) => { vis.push(+n); return m; });
    const L = (p) => colLetter(vis[p] !== undefined ? vis[p] : p);
    const cells = {}, bg = {}, job = {}, occ = {};
    for (const tr of html.split(/<tr\b/i).slice(1)) {
      const th = tr.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i); if (!th) continue;
      const rn = parseInt(decode(th[1]).trim(), 10); if (!rn || rn > MAX_ROW) continue;
      let pos = 0; const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi; let t;
      while ((t = re.exec(tr))) {
        if (/freezebar/i.test(t[1])) continue;
        while (occ[`${rn}:${pos}`]) pos += 1;
        const cs = +((t[1].match(/colspan="?(\d+)/i) || [])[1] || 1), rs = +((t[1].match(/rowspan="?(\d+)/i) || [])[1] || 1);
        for (let r = 0; r < rs; r += 1) for (let c = 0; c < cs; c += 1) occ[`${rn + r}:${pos + c}`] = 1;
        const a = `${L(pos)}${rn}`;
        cells[a] = clean(decode(t[2]));
        const cls = ((t[1].match(/class="([^"]*)"/i) || [])[1] || '').match(/\bs\d+\b/); bg[a] = cls ? styles[cls[0]] || '' : '';
        const j = (t[2].match(/jobs\/([0-9a-f]{8}-[0-9a-f-]{27})/i) || [])[1]; if (j) job[a] = j.toLowerCase();
        pos += cs;
      }
    }
    return { cells, bg, job };
  }
  async function tabList() {
    const h = await gmGet(`https://docs.google.com/spreadsheets/d/${SSID}/htmlview?_=${Date.now()}`);
    const list = [...h.matchAll(/items\.push\(\{name: "([^"]+)"[^}]*?gid: "?(\d+)/g)].map((m) => ({ name: m[1], gid: m[2] }));
    if (!list.length) throw new Error('Could not open Lead Table 2026. Sign in to Google in this Chrome.');
    return list;
  }
  const readTab = async (gid) => parseSheet(await gmGet(`https://docs.google.com/spreadsheets/d/${SSID}/htmlview/sheet?headers=true&gid=${gid}&_=${Date.now()}`));
  function weekOf(d) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const f = (x) => `${x.getMonth() + 1}.${x.getDate()}.${String(x.getFullYear()).slice(-2)}`;
    return { mon, name: `${f(mon)}-${f(sun)}` };
  }
  function findBlocks(cells) {
    const blocks = [];
    for (let r = 3; r <= MAX_ROW; r += 1) {
      const n = REP_COLS.filter((c) => /^\*?\s*[A-Z][a-z]+\s+[A-Z][A-Za-z'-]+/.test(cells[`${c}${r}`] || '')).length;
      if (n >= 15) { blocks.push({ names: r, slots: [r + 1, r + 2, r + 3], pool: [r - 5, r - 4, r - 3] }); r += 6; }
    }
    return blocks.slice(0, 7);
  }
  // open = column B (open slots) - leads waiting in that pool row (TAKEN included); placed pool leads count once
  function rowStatus(t, block, i) {
    const placed = new Set();
    block.slots.concat([block.slots[2] + 1]).forEach((rr) => REP_COLS.forEach((c) => { const j = t.job[`${c}${rr}`]; if (j) placed.add(j); }));
    const pr = block.pool[i]; let waiting = 0, firstEmpty = null;
    REP_COLS.forEach((c) => {
      const a = `${c}${pr}`, v = t.cells[a] || '';
      if (!v) { if (!firstEmpty && t.bg[a] !== PATRICK_BLUE) firstEmpty = a; return; }
      if (SKIP_TEXT.test(v)) return;
      if (t.job[a] && placed.has(t.job[a])) return;
      waiting += 1;
    });
    const b = parseInt(t.cells[`B${block.slots[i]}`], 10);
    // territory counts: open (empty) rep slots in this time row for the Lafayette team and for Louisville
    const terr = {};
    TERRITORIES.forEach((T) => {
      const cols = REP_COLS.filter((c) => T.reps.some((n) => clean(t.cells[`${c}${block.names}`]).replace(/\*/g, '').trim().toLowerCase().startsWith(n)));
      const color = cols.length ? (t.bg[`${cols[0]}${block.names}`] || T.color) : T.color;
      terr[T.key] = { label: T.label, color, open: cols.filter((c) => !t.cells[`${c}${block.slots[i]}`]).length };
    });
    return { open: firstEmpty ? Math.max(0, (Number.isNaN(b) ? 0 : b) - waiting) : 0, firstEmpty, terr };
  }
  async function availability() {
    const list = await tabList();
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const days = []; for (let k = 1; days.length < 3 && k < 8; k += 1) { const d = new Date(today); d.setDate(d.getDate() + k); if (d.getDay() !== 0) days.push(d); }
    const cache = {}; const out = [];
    for (const d of days) {
      const { mon, name } = weekOf(d);
      const label = d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
      const iso = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const tab = list.find((x) => x.name.includes(name));
      if (!tab) { out.push({ iso, label, tab: name, missing: true, slots: [] }); continue; }
      if (!cache[name]) cache[name] = await readTab(tab.gid);
      const idx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - mon) / 86400000);
      const block = findBlocks(cache[name].cells)[idx];
      if (!block) { out.push({ iso, label, tab: name, missing: true, slots: [] }); continue; }
      out.push({ iso, label, tab: name, gid: tab.gid, slots: [0, 1, 2].map((i) => Object.assign({ slot: i, name: SLOT_NAMES[i] }, rowStatus(cache[name], block, i), { idx })) });
    }
    return out;
  }

  // ================= Lead Table tab: does the typing =================
  if (location.hostname === 'docs.google.com') {
    const clickEl = (el) => { const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, buttons: 1 }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 }))); el.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 }))); };
    const activeTab = () => { const a = document.querySelector('.docs-sheet-active-tab'); return a ? clean(a.textContent) : ''; };
    async function switchTo(name) {
      if (activeTab().includes(name)) return;
      const el = [...document.querySelectorAll('.docs-sheet-tab')].find((t) => clean(t.textContent).includes(name));
      if (!el) throw new Error(`No tab ${name} on the Lead Table.`);
      clickEl(el.querySelector('.docs-sheet-tab-name') || el); await sleep(1800);
      if (!activeTab().includes(name)) throw new Error(`Could not open tab ${name}.`);
    }
    async function goTo(addr) {
      const nb = document.querySelector('#t-name-box'); nb.focus(); nb.value = addr; nb.dispatchEvent(new Event('input', { bubbles: true }));
      const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }; nb.dispatchEvent(new KeyboardEvent('keydown', k)); nb.dispatchEvent(new KeyboardEvent('keyup', k));
      await sleep(650); if (nb.value.toUpperCase() !== addr) throw new Error(`Could not select ${addr}.`);
    }
    function commit() {
      const g = document.querySelector('.grid-scrollable-wrapper'); const r = g.getBoundingClientRect(); const ed = document.getElementById('waffle-rich-text-editor').getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.7], [0.7, 0.35]]) { const x = r.x + r.width * fx, y = r.y + r.height * fy; if (x >= ed.left - 6 && x <= ed.right + 6 && y >= ed.top - 6 && y <= ed.bottom + 6) continue; const el = document.elementFromPoint(x, y); if (!el) continue; const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 }))); el.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 }))); return; }
    }
    async function typeIn(addr, text) {
      await goTo(addr); const ed = document.getElementById('waffle-rich-text-editor'); ed.focus();
      const kd = { key: 'a', code: 'KeyA', keyCode: 65, which: 65, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent('keydown', kd)); ed.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, kd, { charCode: 97 })));
      document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); ed.dispatchEvent(new KeyboardEvent('keyup', kd));
      await sleep(400); const ok = ed.getBoundingClientRect().y > -5000; commit(); await sleep(650);
      if (!ok) throw new Error(`Could not type into ${addr}.`);
    }
    async function textColor(addr, name) {
      await goTo(addr); const b = document.getElementById('t-text-color'); clickEl(b); await sleep(600);
      const pick = () => [...document.querySelectorAll('.docs-material-colorpalette')].filter((e) => e.offsetParent !== null).flatMap((p) => [...p.querySelectorAll('.docs-material-colorpalette-cell')]).find((c) => (c.getAttribute('title') || c.getAttribute('aria-label') || '').toLowerCase() === name);
      let c = pick(); if (!c) { await sleep(600); c = pick(); }
      if (!c) { clickEl(b); throw new Error('Red not found in the color palette.'); }
      clickEl(c); await sleep(400);
    }
    async function bold(addr) { await goTo(addr); const b = (document.getElementById('t-bold') || document.getElementById('boldButton')); if (b && !/goog-toolbar-button-checked/.test(b.className) && b.getAttribute('aria-pressed') !== 'true') { clickEl(b); await sleep(300); } }

    // Chrome freezes typing in background tabs, so GroupMe opens this sheet in its OWN visible tab for each
    // "take". When this tab loads with a fresh job waiting, it does the typing, reports back, and GroupMe closes it.
    const runJob = async (job) => {
      const reply = (x) => GM_setValue('slots_res', Object.assign({ id: job.id }, x));
      try {
        for (let k = 0; k < 60 && !(document.querySelector('#t-name-box') && document.querySelector('.docs-sheet-tab') && document.getElementById('waffle-rich-text-editor')); k += 1) await sleep(500);
        await sleep(1500);                                         // let the grid finish drawing
        const days = await availability();                         // re-check: still open, cell still empty
        const day = days.find((d) => d.iso === job.iso); const s = day && day.slots[job.slot];
        if (!s || s.open <= 0 || !s.firstEmpty) { reply({ ok: false, full: true, days }); return; }
        await switchTo(day.tab);
        await typeIn(s.firstEmpty, 'TAKEN');
        await textColor(s.firstEmpty, 'red');
        await bold(s.firstEmpty);
        await sleep(2500);                                         // give Sheets time to save
        const after = await availability();
        const d2 = after.find((d) => d.iso === job.iso);
        reply({ ok: true, cell: s.firstEmpty, days: after, before: s.open, now: d2 ? d2.slots[job.slot].open : null });
      } catch (e) { reply({ ok: false, error: e.message }); }
    };
    const job = GM_getValue('slots_job', null);
    if (job && job.id && !job.claimed && Date.now() - job.ts < 120000) {
      GM_setValue('slots_job', Object.assign({}, job, { claimed: true }));
      runJob(job);
    }
    return;
  }

  // ================= GroupMe: the board =================
  const NAVY = '#1f3a5f', LINE = '#d9dee6', MUTED = '#5f6b7a', GREEN = '#1b7f3a', RED = '#b42318';
  const el = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
  function ask(key, val, answerKey, ms) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`; let lid = null;
      const timer = setTimeout(() => { if (lid !== null) GM_removeValueChangeListener(lid); reject(new Error('timeout')); }, ms);
      lid = GM_addValueChangeListener(answerKey, (n, o, v) => { if (!v || v.id !== id) return; clearTimeout(timer); GM_removeValueChangeListener(lid); resolve(v); });
      GM_setValue(key, Object.assign({ id, ts: Date.now() }, val));
    });
  }

  const btn = el('button', `position:fixed;top:12px;right:80px;z-index:2147483000;background:${NAVY};color:#fff;border:0;border-radius:12px;padding:3px 10px;font:700 11px Arial,sans-serif;letter-spacing:.04em;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer;user-select:none`, 'CONF');
  btn.title = 'Confirmable lead slots - click to open and refresh.';
  const panel = el('div', `position:fixed;z-index:2147483001;width:420px;background:#fff;border:1px solid ${LINE};border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.25);font:13px Arial,sans-serif;color:#1d2430;display:none;overflow:auto`);
  const head = el('div', `padding:12px 16px;background:${NAVY};color:#fff;display:flex;align-items:center;border-radius:10px 10px 0 0`);
  const ht = el('div', 'flex:1'); ht.appendChild(el('div', 'font-weight:700;font-size:14px', 'Confirmable Lead Slots')); ht.appendChild(el('div', 'font-size:11px;opacity:.8;margin-top:2px', 'Lead Table 2026 - next 3 days (from tomorrow)')); head.appendChild(ht);
  const refresh = el('button', 'border:1px solid rgba(255,255,255,.5);background:none;color:#fff;border-radius:6px;padding:4px 10px;font:600 12px Arial,sans-serif;cursor:pointer;margin-right:8px', 'Refresh');
  const x = el('button', 'border:0;background:none;color:#fff;font-size:20px;cursor:pointer;line-height:1', '×');
  head.appendChild(refresh); head.appendChild(x);
  const status = el('div', `padding:8px 16px;color:${MUTED};font-size:12px;border-bottom:1px solid ${LINE}`, '');
  const body = el('div', 'padding:12px 16px 16px');
  panel.appendChild(head); panel.appendChild(status); panel.appendChild(body);
  document.body.appendChild(panel); document.body.appendChild(btn);

  const place = () => {
    if (panel.style.display === 'none') return;
    const r = btn.getBoundingClientRect(), M = 8, pw = Math.min(420, innerWidth - 2 * M);
    panel.style.width = pw + 'px'; panel.style.left = Math.max(M, Math.min(r.right - pw, innerWidth - pw - M)) + 'px';
    const above = r.top - 2 * M, below = innerHeight - r.bottom - 2 * M, room = Math.max(220, Math.max(above, below));
    panel.style.maxHeight = room + 'px'; const ph = Math.min(panel.scrollHeight, room);
    panel.style.top = Math.max(M, Math.min(below >= above ? r.bottom + M : r.top - M - ph, innerHeight - ph - M)) + 'px';
  };
  // sits just to the right of the thread name at the top of the chat
  let moved = false;
  const threadTitle = () => {
    const name = clean(document.title.replace(/^GroupMe\s*[|\-–]\s*/i, '')).toLowerCase();
    let best = null;
    document.querySelectorAll('body *').forEach((e) => {
      if (e === btn || panel.contains(e) || e.closest('nav, aside, [role="navigation"]')) return;
      const txt = clean(e.textContent).toLowerCase();
      if (!txt || txt.length > 80) return;
      if (name && name !== 'groupme' ? txt.indexOf(name) !== 0 : false) return;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.top < 0 || r.top > 140 || r.left < innerWidth * 0.2 || r.height > 60) return;
      if (!best || r.width * r.height < best.r.width * best.r.height) best = { e, r };
    });
    return best;
  };
  const dock = () => {
    const t = threadTitle();
    if (!t) { btn.style.left = 'auto'; btn.style.right = '80px'; btn.style.top = '12px'; return; }
    const tr = t.e.getBoundingClientRect();
    const textW = (() => { const rg = document.createRange(); rg.selectNodeContents(t.e); const rr = rg.getBoundingClientRect(); return rr.width ? rr : tr; })();
    btn.style.right = 'auto';
    btn.style.left = Math.min(innerWidth - btn.offsetWidth - 8, textW.right + 10) + 'px';
    btn.style.top = (textW.top + textW.height / 2 - btn.offsetHeight / 2) + 'px';
    place();
  };
  setInterval(dock, 800); addEventListener('resize', dock); setTimeout(dock, 300);
  addEventListener('resize', place); new MutationObserver(place).observe(body, { childList: true, subtree: true });

  let busy = false, pending = null, lastDays = null;
  function render(days) {
    lastDays = days; body.textContent = '';
    days.forEach((d) => {
      const card = el('div', `border:1px solid ${LINE};border-radius:8px;margin-bottom:10px;overflow:hidden`);
      card.appendChild(el('div', `padding:7px 10px;background:#f4f6f9;font-weight:700;border-bottom:1px solid ${LINE}`, d.label));
      const row = el('div', 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:10px');
      if (d.missing) { row.style.display = 'block'; row.appendChild(el('div', `color:${MUTED};font-size:12px`, `No tab ${d.tab} on the Lead Table yet.`)); }
      d.slots.forEach((s) => {
        const full = s.open <= 0, sel = pending && pending.iso === d.iso && pending.slot === s.slot;
        const tile = el('button', `border:1px solid ${full ? LINE : sel ? RED : '#b9d7c2'};background:${full ? '#f7f7f8' : sel ? '#fdecea' : '#f1f8f3'};border-radius:8px;padding:10px 6px;text-align:center;cursor:${full ? 'default' : 'pointer'};font:13px Arial,sans-serif;color:#1d2430`);
        tile.appendChild(el('div', `font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.05em`, s.name));
        tile.appendChild(el('div', `font-size:22px;font-weight:700;color:${full ? '#9aa3af' : GREEN};margin:2px 0`, String(s.open)));
        if (s.terr) {
          const tl = el('div', 'display:flex;justify-content:center;gap:8px;font-size:11px;font-weight:700;margin-bottom:2px');
          Object.values(s.terr).forEach((T) => tl.appendChild(el('span', `color:${T.color}`, `${T.label} = ${T.open}`)));
          tile.appendChild(tl);
        }
        tile.appendChild(el('div', `font-size:11px;color:${sel ? RED : MUTED};font-weight:${sel ? 700 : 400}`, full ? 'Full' : sel ? 'Click again to take' : (s.open === 1 ? 'lead open' : 'leads open')));
        tile.disabled = full;
        tile.onclick = () => { if (full || busy) return; if (!sel) { pending = { iso: d.iso, slot: s.slot }; render(days); return; } take(d, s); };
        row.appendChild(tile);
      });
      card.appendChild(row); body.appendChild(card);
    });
    body.appendChild(el('div', `color:${MUTED};font-size:11px`, 'Click a slot, then click it again to mark it TAKEN on the Lead Table (a Lead Table tab opens for a few seconds and closes). Counts update when you open this, press Refresh, or take a slot.'));
  }
  async function load() {
    if (busy) return; busy = true; pending = null; status.style.color = MUTED; status.textContent = 'Loading from Lead Table 2026...';
    try { render(await availability()); status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; }
    catch (e) { status.style.color = RED; status.textContent = e.message; }
    busy = false;
  }
  async function take(d, s) {
    busy = true; status.style.color = MUTED; status.textContent = `Marking ${d.label} ${s.name} as TAKEN - the Lead Table opens for a moment...`;
    let tab = null;
    try {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const done = new Promise((resolve, reject) => {
        let lid = null;
        const timer = setTimeout(() => { if (lid !== null) GM_removeValueChangeListener(lid); reject(new Error('timeout')); }, 120000);
        lid = GM_addValueChangeListener('slots_res', (n, o, v) => { if (!v || v.id !== id) return; clearTimeout(timer); GM_removeValueChangeListener(lid); resolve(v); });
      });
      GM_setValue('slots_job', { id, iso: d.iso, slot: s.slot, ts: Date.now() });
      tab = GM_openInTab(`https://docs.google.com/spreadsheets/d/${SSID}/edit#gid=${d.gid}`, { active: true, insert: true, setParent: true });
      const r = await done;
      try { tab.close(); } catch (e) { /* user may have closed it */ }
      pending = null; if (r.days) render(r.days);
      if (!r.ok) throw new Error(r.full ? `${d.label} ${s.name} was just filled - pick another slot.` : (r.error || 'Could not take the slot.'));
      status.style.color = GREEN; status.textContent = `${d.label} ${s.name} taken - Lead Table cell ${r.cell}.`;
    } catch (e) {
      status.style.color = RED;
      status.textContent = e.message === 'timeout' ? 'The Lead Table tab did not finish. Check the tab that opened, then press Refresh.' : e.message;
      if (lastDays) render(lastDays);
    }
    busy = false;
  }
  btn.onclick = () => { if (moved) { moved = false; return; } if (panel.style.display === 'none') { panel.style.display = 'block'; place(); load(); } else panel.style.display = 'none'; };
  refresh.onclick = load; x.onclick = () => { panel.style.display = 'none'; };
  ['keydown', 'keypress', 'keyup'].forEach((ev) => panel.addEventListener(ev, (e) => e.stopPropagation()));
})();
