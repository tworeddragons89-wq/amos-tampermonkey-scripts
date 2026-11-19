// ==UserScript==
// @name         Amos - Enter Dispo
// @namespace    amos-exteriors
// @version      3.1
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-dispo.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-dispo.user.js
// @description  Adds an "Enter Dispo" button to a rep's GroupMe messages. Click it, pick the rep's appointment (today or tomorrow, from the AccuLynx calendar), then choose "Got it" or "current": the message is posted as a comment on that job and your reply is typed in the thread.
// @match        https://web.groupme.com/*
// @match        https://my.acculynx.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_removeValueChangeListener
// @connect      my.acculynx.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY_JOB = 'amosDispoJob';     // dispo waiting to be entered in AccuLynx
  const KEY_DONE = 'amosDispoDone';   // AccuLynx tells GroupMe it finished
  const KEY_REQ = 'amosDispoReq';     // GroupMe asks an open AccuLynx tab to fetch calendar data (backup route)
  const KEY_RESP = 'amosDispoResp';   // the AccuLynx tab's answer
  const ACCULYNX_URL = 'https://my.acculynx.com/dashboard';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(300);
    }
    return null;
  }
  function toast(msg, color = '#2b7') {
    const d = document.createElement('div');
    d.textContent = msg;
    Object.assign(d.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
      background: color, color: '#fff', padding: '10px 14px', borderRadius: '6px',
      font: '14px sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '360px'
    });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 9000);
  }
  // Type into an input/textarea/contenteditable so the web app "sees" it
  function typeInto(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }
  // A small badge that stays on screen and says which step the script is on, so a stall is never silent
  function status(msg, color = '#0a6cff') {
    let d = document.getElementById('amosDispoStatus');
    if (!d) {
      d = document.createElement('div');
      d.id = 'amosDispoStatus';
      Object.assign(d.style, {
        position: 'fixed', bottom: '70px', right: '20px', zIndex: 999999, color: '#fff', padding: '8px 12px',
        borderRadius: '6px', font: '13px sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '360px'
      });
      document.body.appendChild(d);
    }
    d.style.background = color;
    d.textContent = 'Enter Dispo: ' + msg;
  }
  const visible = (el) => el && el.offsetParent !== null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // <parse>
  // Find an AccuLynx job number ("IN-4521") in the dispo. Careful: a state + ZIP such as
  // "Anytown, IN 46000" looks like a job number but is not one, and neither is "in 2027".
  function findJobNum(text) {
    for (const m of text.matchAll(/(^|[^A-Za-z0-9])(in)([-\s]?)(\d{3,6})\b/gi)) {
      const before = text.slice(0, m.index + m[1].length);
      if (/,\s*$/.test(before)) continue;                          // ", IN 46000" = state + ZIP
      if (m[3] !== '-' && m[2] !== 'IN') continue;                 // plain word "in 500" is not a job #
      if (m[3] !== '-' && /^4[67]\d{3}$/.test(m[4])) continue;     // Indiana ZIP code
      return 'IN-' + m[4];
    }
    return '';
  }
  // Work out how to find the lead in AccuLynx. AccuLynx search takes a Job #,
  // customer name or address (NOT a phone number), so: job # first, then name.
  function parseLead(text) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const jobNum = findJobNum(text);
    const addrLine = lines.find((l) => /^\d{1,6}\s+[A-Za-z]/.test(l) && !/^\d{3}[\s.)-]+\d{3}/.test(l));
    const addr = addrLine ? norm(addrLine).split(' ').slice(0, 2).join(' ') : '';

    const isCityLine = (l) => /^[A-Za-z .'-]+,\s*([A-Z]{2}\b|Indiana|Ohio|Kentucky|Illinois|Michigan)/.test(l);
    const lastFirst = /^[A-Za-z'’.\-]+(\s[A-Za-z'’.\-]+)?\s*,\s*[A-Za-z]/;   // "Doe, Jane and John" / "Smith , Anna"
    const headerLine = lines.slice(0, 3).find((l) => /^IN[-\s]?\d{3,6}\s*[:\-]?\s*[A-Za-z]/.test(l));   // "IN-4521 Jane Doe"
    let nameLine = headerLine || lines.slice(0, 6).find((l) => lastFirst.test(l) && !isCityLine(l) && !/^\w+:/.test(l));
    if (!nameLine) {
      nameLine = lines.find((l) => !/^\d/.test(l) && !/:\s*$/.test(l) && !/^(customer|job|lead|product|demo|price|payment)/i.test(l));
    }
    let tokens = [], search = '';
    if (nameLine && lastFirst.test(nameLine) && !isCityLine(nameLine)) {   // "Doe, Jane and John"
      const [last, rest] = nameLine.split(',');
      tokens = [...norm(last).split(' '), norm(rest).split(' ')[0]].filter(Boolean);
      search = last.trim();
    } else if (nameLine) {                                     // "Jane Doe"
      // Only the name part: before the first comma / dash (drops "Monday, Nov 2 · 4–6 PM" etc.)
      const nameOnly = nameLine.replace(/^IN[-\s]?\d+\s*[:\-]?\s*/i, '').split(/[,·–—]| - /)[0];
      const words = norm(nameOnly).split(' ').filter((w) => w && w !== 'and');
      tokens = words;
      search = words.length > 2 ? words[words.length - 1] : words.join(' ');
    }
    // Best thing to search: job # → street address (very unique) → customer name
    // AccuLynx abbreviates ("Cir", "Dr", "St"), so drop the street-type word from the search
    // (and keep only the street part: "123 Main Station, Zionsville, IN" → "123 Main Station")
    const addrFull = addrLine ? addrLine.split(',')[0].replace(/[,\s]+$/, '')
      .replace(/\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|boulevard|blvd|way|place|pl|parkway|pkwy|trail|trl|terrace|ter)\.?$/i, '') : '';
    const nameSearch = search;
    if (addrFull) search = addrFull;
    if (jobNum) search = jobNum;
    // Backups, tried in this order if the first search finds nothing. The IN number in a dispo is
    // not always searchable in AccuLynx (a lead can carry it only inside its emails), so the
    // address and then the name must be able to find the job.
    const alts = [addrFull, nameSearch].filter((s, i, a) => s && s !== search && a.indexOf(s) === i);
    return { jobNum, search, alts, tokens, addr };
  }
  // A line of the dispo that is distinctive enough to tell if it is already on the job.
  // Only the LAST lines count: that is where the rep writes the result. Everything above
  // (name, address, lead-sheet fields) is already on the job from when the lead was entered.
  function dupKey(text) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean).slice(1);   // skip line 1 (name / header)
    const cands = lines.slice(-3).filter((l) =>
      l.length >= 20 && !/^[A-Za-z][A-Za-z \/]*:/.test(l) && !/^\d/.test(l) &&
      !/\d{3}[\s.)-]+\d{3}/.test(l) && !/,\s*[A-Z]{2}\b/.test(l) && !/@/.test(l));
    return cands.sort((a, b) => b.length - a.length)[0] || oneLineKey(text);
  }

  // ---------- Appointment picker helpers (pure, unit-tested) ----------
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const pad2 = (n) => String(n).padStart(2, '0');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtClock = (min) => { const m = min % 1440; const h = (Math.floor(m / 60) % 12) || 12; return `${h}:${pad2(m % 60)} ${m >= 720 ? 'PM' : 'AM'}`; };
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function parseLocal(v) {
    if (!v) return null;
    if (typeof v === 'object') v = v.Local || v.local || v.DateTime || v.Value || '';
    v = String(v);
    let m = v.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, min: +m[4] * 60 + +m[5] };
    m = v.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
    if (m) {
      let h = +m[4]; const ap = (m[6] || '').toUpperCase();
      if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
      return { date: `${m[3]}-${pad2(+m[1])}-${pad2(+m[2])}`, min: h * 60 + +m[5] };
    }
    return null;
  }
  // Which AccuLynx calendar belongs to the rep this GroupMe thread is named after?
  // Matches on the last name (GroupMe says "Rob", AccuLynx says "Robert"); returns null if unsure so the picker shows a drop-down.
  function calendarForOwner(owner, calendars) {
    const o = clean(owner).replace(/\s+\d+$/, '');
    let first = '', last = '';
    const cm = o.match(/^([^,]+),\s*(.+)$/);
    if (cm) { last = norm(cm[1]).split(' ').pop(); first = norm(cm[2]).split(' ')[0]; }
    else { const w = norm(o).split(' ').filter(Boolean); first = w[0] || ''; last = w.length > 1 ? w[w.length - 1] : ''; }
    if (!last) return null;
    const bySur = (calendars || []).filter((c) => norm(c.name).split(' ').includes(last));
    if (bySur.length === 1) return bySur[0];
    if (bySur.length > 1) return bySur.find((c) => norm(c.name).startsWith(first.slice(0, 2))) || null;
    return null;
  }
  // Turn the AccuLynx appointments search answer into simple rows: name, address, date + time.
  // Customer appointments (type 2) always; job tasks (type 1 tied to a job) only if includeTasks.
  function normalizeAppts(raw, includeTasks) {
    let list = raw;
    if (!Array.isArray(list)) list = (raw && (raw.Appointments || raw.Items || raw.Results || raw.Data || raw.Events)) || (raw && Object.values(raw).find(Array.isArray)) || [];
    const out = []; const seen = new Set();
    for (const e of list) {
      const type = +(e.EventType || 0);
      const ref = String(e.ReferenceId || e.JobId || '');
      if (type !== 2 && !(includeTasks && type === 1 && GUID.test(ref))) continue;
      const occs = (e.Occurrences && e.Occurrences.length) ? e.Occurrences : [{ Start: e.Start, End: e.End }];
      for (const o of occs) {
        const s = parseLocal(o.Start); const en = parseLocal(o.End);
        if (!s) continue;
        const key = [ref, s.date, s.min, e.Title].join('|');
        if (seen.has(key)) continue; seen.add(key);
        let a = (o && (o.Address || o.address)) || e.Address || e.address || (e.Meta && (e.Meta.jobAddress || e.Meta.address || e.Meta.Address)) || '';
        if (a && typeof a === 'object') a = [a.Street || a.Address1 || a.Line1 || a.street, a.City || a.city, a.State || a.state, a.Zip || a.ZipCode || a.PostalCode || a.zip].filter(Boolean).join(', ');
        const full = clean((e.Meta && (e.Meta.jobName || e.Meta.JobName)) || e.JobName || e.Title || '');
        const jm = full.match(/^(IN-\d+)\s*:?\s*/i);
        const title = clean(e.Title || '');
        out.push({
          ref, type, title, jobNum: jm ? jm[1].toUpperCase() : '', name: full.replace(/^IN-\d+\s*:?\s*/i, '') || title,
          address: clean(a), date: s.date, sMin: s.min, eMin: en && en.date === s.date ? en.min : s.min + 60,
          cxl: /\b(cxl|cxld|cancel|cancelled|canceled)\b/i.test(title)
        });
      }
    }
    return out.sort((x, y) => x.date.localeCompare(y.date) || x.sMin - y.sMin);
  }
  // How well does an appointment match the pasted dispo? (used only to pre-highlight a row)
  function scoreAppt(a, lead) {
    let s = 0;
    const nm = norm(a.name + ' ' + a.title);
    if (lead.jobNum && a.jobNum && a.jobNum === lead.jobNum) s = 100;
    if (lead.addr && norm(a.address).includes(lead.addr)) s = Math.max(s, 80);
    const toks = lead.tokens || [];
    if (toks.length >= 2 && toks.every((k) => nm.includes(k))) s = Math.max(s, 70);
    return s;
  }
  function bestAppt(appts, lead) {
    const scored = appts.map((a, i) => ({ i, s: scoreAppt(a, lead) })).filter((x) => x.s >= 70).sort((x, y) => y.s - x.s);
    if (!scored.length) return -1;
    if (scored.length > 1 && scored[1].s === scored[0].s) return -1;
    return scored[0].i;
  }
  // A one-line message ("running late to my 2") has no "last lines" - use the whole line to spot a repeat.
  const oneLineKey = (text) => { const l = text.split('\n').map((x) => x.trim()).filter(Boolean); return l.length === 1 && l[0].length >= 12 ? l[0] : ''; };
  // Insurance box triggers: words in the dispo turn on the matching box automatically
  const hit = (t, re, no) => { const s = String(t || ''); return re.test(s) && !no.test(s); };
  const wantsDamage = (t) => hit(t, /found\s+damage/i, /(?:\bno|\bnot|n't|\bwithout)\s+found\s+damage|found\s+damage\s*[:\-?]*\s*(?:no|none|n\/a|false)\b/i);
  const wantsClaim = (t) => hit(t, /filed\s+(?:a\s+)?claim/i, /(?:\bno|\bnot|n't|\bnever|\bhaven't)\s+(?:yet\s+)?filed\s+(?:a\s+)?claim|filed\s+claim\s*[:\-?]*\s*(?:no|none|n\/a|false)\b/i);
  // </parse>

  // =====================================================================
  //  GROUPME SIDE
  // =====================================================================
  if (location.host === 'web.groupme.com') {

    // Each GroupMe tab gets an id so only the tab that clicked reacts when AccuLynx finishes
    let TAB_ID = sessionStorage.getItem('amosTabId');
    if (!TAB_ID) { TAB_ID = String(Math.random()).slice(2); sessionStorage.setItem('amosTabId', TAB_ID); }

    // ---------- Per-thread ON/OFF toggle ----------
    const KEY_THREADS = 'amosDispoThreads';
    const threadId = () => (location.pathname.match(/\/chats\/[^/]+\/([^/?#]+)/) || [])[1] || '';
    const isOn = () => !!GM_getValue(KEY_THREADS, {})[threadId()];
    function setOn(on) {
      const all = GM_getValue(KEY_THREADS, {});
      if (on) all[threadId()] = document.title.replace(/^GroupMe \|\s*/, '');
      else delete all[threadId()];
      GM_setValue(KEY_THREADS, all);
    }
    function drawToggle() {
      let t = document.getElementById('amosDispoToggle');
      if (!threadId()) { if (t) t.remove(); return; }
      if (!t) {
        t = document.createElement('button');
        t.id = 'amosDispoToggle';
        Object.assign(t.style, {
          position: 'fixed', top: '14px', right: '16px', zIndex: 999999, padding: '4px 10px',
          border: 'none', borderRadius: '12px', cursor: 'pointer', font: '600 12px Arial', color: '#fff'
        });
        t.addEventListener('click', () => { setOn(!isOn()); refresh(); });
        document.body.appendChild(t);
      }
      const on = isOn();
      t.textContent = on ? 'Dispos: ON' : 'Dispos: OFF';
      t.style.background = on ? '#2b7' : '#6b7280';
      // Sit immediately to the right of the Leads toggle, same size and top edge.
      const leads = document.getElementById('amos-lead-toggle');
      if (leads) {
        const lr = leads.getBoundingClientRect();
        if (lr.width) {
          t.style.top = lr.top + 'px';
          t.style.right = Math.max(4, window.innerWidth - lr.right - 6 - t.getBoundingClientRect().width) + 'px';
        }
      }
    }
    function removeButtons() {
      document.querySelectorAll('.amosDispoBtn').forEach((b) => b.remove());
    }
    function refresh() {
      drawToggle();
      if (isOn()) addButtons(); else removeButtons();
    }

    // ---------- Reading GroupMe messages ----------
    // GroupMe marks each message with data-message. Plain text posts are labeled
    // "Name: text"; photo posts "Message. Received from Name".
    const allMsgs = () => [...document.querySelectorAll('[data-message]')];
    function senderOf(m) {
      const g = m.querySelector('[role="group"][aria-label]');
      const label = g ? g.getAttribute('aria-label') : '';
      const pm = label.match(/^Message\.\s*(?:Received from|Sent by)\s+(.*?)(?:\.\s*Pinned)?$/i);
      if (pm) return pm[1].trim();
      const i = label.indexOf(': ');
      return i > 0 ? label.slice(0, i).trim() : '';
    }
    // The thread is named after the rep, but GroupMe may show their posts as "Freddy",
    // "Duke Antonijevic 2" or "Karandos,David" — so ignore word order and extras:
    // every word of the shorter name must appear in the longer one.
    function isOwner(sender, owner) {
      const s = norm(sender).split(' ').filter(Boolean), o = norm(owner).split(' ').filter(Boolean);
      if (!s.length || !o.length) return false;
      const [small, big] = s.length <= o.length ? [s, o] : [o, s];
      return small.every((w) => big.includes(w));
    }
    // The text part of the message (never the photo)
    const textBlock = (msg) => {
      let t = msg.querySelector('[data-text-message-content]');
      if (!t) {                                   // photo + text posts
        const ps = [...msg.querySelectorAll('p')].filter((p) => p.innerText.trim());
        const p = ps[ps.length - 1];
        t = p ? (p.closest('[data-yourmessage]') || p.parentElement) : null;
      }
      return t && t.innerText.trim().length >= 8 ? t : null;
    };
    function dispoText(anchor) {
      const paras = [...anchor.querySelectorAll('p')].map((p) => p.innerText.trim()).filter(Boolean);
      let text = paras.join('\n');
      if (!text) {
        const clone = anchor.cloneNode(true);
        clone.querySelectorAll('button').forEach((b) => b.remove());
        text = clone.innerText.replace(/^.*\d{1,2}:\d{2}\s*(AM|PM)\s*\n+/i, '').trim();
      }
      // GroupMe can leave invisible placeholder characters in a name ("Smith<obj>, John"); they break name matching.
      // Written as escapes (object-replacement char, zero-width chars, BOM) so copy/paste can never corrupt the range.
      return text.replace(/[￼​-‍⁠﻿]/g, '');
    }

    // Time of a post. GroupMe shows the time only on the first of several back-to-back
    // posts by the same person, so walk back up that run until a time is found.
    function postTime(msg) {
      const list = allMsgs(), who = senderOf(msg);
      for (let i = list.indexOf(msg); i >= 0; i--) {
        if (senderOf(list[i]) !== who) break;
        const te = list[i].querySelector('[data-message-time]');
        if (te && /\d{1,2}:\d{2}/.test(te.textContent)) return te.textContent.trim();
      }
      return '';
    }


    // ---------- AccuLynx data access (calendar + appointments) ----------
    function gmReq(method, path, body) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method, url: 'https://my.acculynx.com' + path, timeout: 30000,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          data: body ? JSON.stringify(body) : undefined,
          onload: resolve, onerror: () => reject(new Error('network error')), ontimeout: () => reject(new Error('timeout'))
        });
      });
    }
    // Backup route: ask an AccuLynx tab that is already open to make the call for us
    function relayReq(method, path, body) {
      return new Promise((resolve, reject) => {
        const id = Date.now() + '-' + Math.random().toString(36).slice(2);
        let lid = null;
        const timer = setTimeout(() => { if (lid !== null) GM_removeValueChangeListener(lid); reject(new Error('no AccuLynx tab answered')); }, 15000);
        lid = GM_addValueChangeListener(KEY_RESP, (_n, _o, v) => {
          if (!v || v.id !== id) return;
          clearTimeout(timer); GM_removeValueChangeListener(lid); resolve(v);
        });
        GM_setValue(KEY_REQ, { id, method, path, body, ts: Date.now() });
      });
    }
    async function acculynx(method, path, body) {
      try {
        const r = await gmReq(method, path, body);
        const t = r.responseText || '';
        if (r.status >= 200 && r.status < 300 && /^\s*[\[{]/.test(t)) return JSON.parse(t);
      } catch (e) { /* fall through to the backup route */ }
      const resp = await relayReq(method, path, body);
      if (!resp.ok) throw new Error('AccuLynx answered ' + (resp.status || resp.error || 'with an error'));
      return JSON.parse(resp.text);
    }
    async function getCalendars() {
      const arr = await acculynx('GET', '/api/v4/calendars');
      return (Array.isArray(arr) ? arr : []).map((c) => ({ id: c.CalendarId || c.Id || c.id, name: clean(c.Name || c.name) })).filter((c) => c.id && c.name);
    }
    const slashDate = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} 00:00:00`;
    async function getAppointments(calId, includeTasks) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);     // today + tomorrow
      const raw = await acculynx('POST', '/api/v4/appointments/search', {
        CalendarIds: [calId], EventTypes: [1, 2], DateRange: { Start: slashDate(start), End: slashDate(end) }, Filters: []
      });
      return normalizeAppts(raw, includeTasks);
    }

    // ---------- Start the entry: open the job (or search) in AccuLynx; the reply word comes from the button chosen ----------
    function launch(ctx, jobId, reply, flags) {
      const lead = ctx.lead;
      if (!jobId && !lead.search) {
        const typed = prompt('Could not read a job #, address or name from this message. Type what to search AccuLynx for:', '');
        if (!typed) return false;
        const jm = typed.match(/IN[-\s]?(\d{3,6})/i);
        lead.jobNum = jm ? 'IN-' + jm[1] : '';
        lead.search = typed.trim(); lead.alts = []; lead.tokens = norm(typed).split(' ').filter(Boolean); lead.addr = '';
      }
      const created = Date.now();
      GM_deleteValue(KEY_DONE);
      GM_setValue(KEY_JOB, Object.assign({}, lead, {
        jobId: jobId || '', reply, dam: !!(flags && flags.dam), claim: !!(flags && flags.claim),
        rep: ctx.rep, time: ctx.time, text: ctx.text,
        comment: `Dispo from ${ctx.rep} (${ctx.time}):\n${ctx.text}`,
        threadUrl: location.href, originTab: TAB_ID, created
      }));
      const btn = ctx.btn;
      btn.textContent = 'Entering...'; btn.disabled = true;
      // If AccuLynx has not reported back in 90 seconds, say so and free the button instead of hanging
      setTimeout(() => {
        if (btn.textContent === 'Entering...') {
          btn.textContent = 'Enter Dispo'; btn.disabled = false;
          toast('The AccuLynx tab did not finish. Check its tab (the blue/red "Enter Dispo" badge says where it stopped), then click Enter Dispo again.', '#e80');
        }
      }, 90 * 1000);
      try {
        const url = jobId ? `https://my.acculynx.com/jobs/${jobId}/comments?amosDispo=${created}` : ACCULYNX_URL + '?amosDispo=' + created;
        GM_openInTab(url, { active: true });
      } catch (err) {
        toast('Could not open AccuLynx: ' + (err && err.message ? err.message : err), '#c33');
        btn.textContent = 'Enter Dispo'; btn.disabled = false;
      }
      return true;
    }

    // ---------- The appointment picker ----------
    function closePicker() { const o = document.getElementById('amosPickerOv'); if (o) o.remove(); }
    function openPicker(ctx) {
      closePicker();
      const el = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text !== undefined) e.textContent = text; return e; };
      const autoDam = wantsDamage(ctx.text), autoClaim = wantsClaim(ctx.text);
      const flags = {};                                  // per appointment index: { dam, claim }
      const flagsOf = (i) => (flags[i] = flags[i] || { dam: autoDam, claim: autoClaim });
      const textFlags = { dam: autoDam, claim: autoClaim };
      const ov = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center');
      ov.id = 'amosPickerOv';
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) closePicker(); });
      const box = el('div', 'background:#fff;color:#222;width:min(580px,94vw);max-height:88vh;display:flex;flex-direction:column;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);font:14px Arial,sans-serif');
      const head = el('div', 'padding:12px 14px;border-bottom:1px solid #ddd');
      head.appendChild(el('div', 'font-weight:bold;font-size:15px', 'Which appointment is this about?'));
      const preview = ctx.text.length > 160 ? ctx.text.slice(0, 157) + '...' : ctx.text;
      head.appendChild(el('div', 'margin-top:4px;color:#555;font-size:12px;white-space:pre-wrap', `${ctx.rep}: ${preview}`));
      const calRow = el('div', 'margin-top:8px;display:flex;gap:8px;align-items:center;font-size:12px');
      calRow.appendChild(el('span', '', 'Calendar:'));
      const calSel = el('select', 'padding:3px 6px;font-size:12px;max-width:260px');
      calRow.appendChild(calSel);
      const tasksLbl = el('label', 'margin-left:auto;display:flex;align-items:center;gap:4px;cursor:pointer');
      const tasksBox = el('input'); tasksBox.type = 'checkbox';
      tasksLbl.appendChild(tasksBox); tasksLbl.appendChild(document.createTextNode('Show job tasks too'));
      calRow.appendChild(tasksLbl);
      head.appendChild(calRow);
      const status = el('div', 'padding:8px 14px;color:#555;font-size:13px', 'Loading the AccuLynx calendar...');
      const list = el('div', 'overflow:auto;padding:0 10px 6px;flex:1;min-height:80px');
      const foot = el('div', 'padding:10px 14px;border-top:1px solid #ddd;display:flex;flex-wrap:wrap;gap:8px;align-items:center');
      const textLbl = el('label', 'flex:1 1 100%;display:flex;align-items:center;gap:6px;font-size:12px;color:#555;cursor:pointer');
      const textBox = el('input'); textBox.type = 'checkbox';
      textLbl.appendChild(textBox); textLbl.appendChild(document.createTextNode('Not on the calendar? Find the job by the name / address / job # in the message instead'));
      const mkBtn = (label, bg) => { const b = el('button', `background:${bg};color:#fff;border:0;border-radius:6px;padding:9px 18px;font:bold 14px Arial,sans-serif;cursor:pointer`, label); b.disabled = true; b.style.opacity = '.45'; return b; };
      const bGot = mkBtn('Got it', '#2b7'), bCur = mkBtn('current', '#0a6cff');
      const bCancel = el('button', 'margin-left:auto;background:#eee;color:#222;border:0;border-radius:6px;padding:9px 14px;font:14px Arial,sans-serif;cursor:pointer', 'Cancel');
      bCancel.addEventListener('click', closePicker);
      const tf = el('div', 'flex:1 1 100%;display:flex;gap:14px;font-size:12px;color:#555;font-weight:bold');
      [['dam', 'Dam (Found Damage)'], ['claim', 'Claim (Filed Claim)']].forEach(([k, lab]) => {
        const l = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer'); const c = el('input'); c.type = 'checkbox'; c.checked = !!textFlags[k];
        c.addEventListener('change', () => { textFlags[k] = c.checked; }); l.appendChild(c); l.appendChild(document.createTextNode(lab)); tf.appendChild(l);
      });
      textLbl.appendChild(document.createElement('span'));
      foot.appendChild(textLbl); foot.appendChild(tf); foot.appendChild(bGot); foot.appendChild(bCur); foot.appendChild(bCancel);
      box.appendChild(head); box.appendChild(status); box.appendChild(list); box.appendChild(foot);
      ov.appendChild(box); document.body.appendChild(ov);

      let calendars = [], appts = [], sel = -1;
      const updateButtons = () => {
        const ok = textBox.checked || sel >= 0;
        [bGot, bCur].forEach((b) => { b.disabled = !ok; b.style.opacity = ok ? '1' : '.45'; });
      };
      const dayLabel = (iso) => {
        const now = new Date(); const t = isoOf(now); const tm = isoOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
        const d = new Date(iso + 'T12:00:00');
        return `${iso === t ? 'Today' : iso === tm ? 'Tomorrow' : ''} ${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`.trim();
      };
      const render = () => {
        list.textContent = '';
        let lastDay = '';
        appts.forEach((a, i) => {
          if (a.date !== lastDay) { lastDay = a.date; list.appendChild(el('div', 'margin:10px 4px 4px;font-weight:bold;font-size:12px;color:#0a6cff;text-transform:uppercase', dayLabel(a.date))); }
          const on = i === sel && !textBox.checked;
          const row = el('div', `border:2px solid ${on ? '#0a6cff' : '#e3e3e3'};background:${on ? '#eaf2ff' : '#fff'};border-radius:8px;padding:8px 10px;margin:4px 0;cursor:pointer`);
          row.appendChild(el('div', 'font-weight:bold', a.name + (a.cxl ? '  (CXL)' : '') + (a.type === 1 ? '  [task: ' + a.title + ']' : '')));
          row.appendChild(el('div', 'color:#444;font-size:13px', a.address || '(no address on the appointment)'));
          const rd = new Date(a.date + 'T12:00:00');
          row.appendChild(el('div', 'color:#444;font-size:13px', `${DOW[rd.getDay()]} ${rd.getMonth() + 1}/${rd.getDate()} · ${fmtClock(a.sMin)} – ${fmtClock(a.eMin)}`));
          row.style.display = 'flex'; row.style.gap = '10px'; row.style.alignItems = 'center';
          [...row.children].forEach((c) => { c.style.flex = ''; });
          const left = el('div', 'flex:1;min-width:0');
          while (row.firstChild) left.appendChild(row.firstChild);
          row.appendChild(left);
          const fl = flagsOf(i);
          const side = el('div', 'display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:bold;flex:none');
          [['dam', 'Dam', 'Found Damage: puts True in Damage Location'], ['claim', 'Claim', 'Filed Claim: checks Filed Claim and fills the date']].forEach(([k, lab, tip]) => {
            const l = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap'); l.title = tip;
            const c = el('input'); c.type = 'checkbox'; c.checked = !!fl[k];
            c.addEventListener('click', (e) => e.stopPropagation());
            c.addEventListener('change', () => { fl[k] = c.checked; });
            l.addEventListener('click', (e) => e.stopPropagation());
            l.appendChild(c); l.appendChild(document.createTextNode(lab)); side.appendChild(l);
          });
          row.appendChild(side);
          row.addEventListener('click', () => { sel = i; textBox.checked = false; render(); updateButtons(); });
          list.appendChild(row);
        });
        updateButtons();
      };
      const loadAppts = async () => {
        const cal = calendars.find((c) => c.id === calSel.value);
        sel = -1; appts = []; list.textContent = '';
        if (!cal) { status.textContent = 'Pick the rep\'s calendar above.'; return; }
        status.textContent = `Loading ${cal.name}'s appointments...`;
        try {
          appts = await getAppointments(cal.id, tasksBox.checked);
          sel = bestAppt(appts, ctx.lead);
          status.textContent = appts.length
            ? `${appts.length} appointment${appts.length === 1 ? '' : 's'} on ${cal.name}'s calendar (today and tomorrow). Tap the right one, then choose your reply.`
            : `Nothing on ${cal.name}'s calendar for today or tomorrow. Try another calendar, "Show job tasks too", or the search option below.`;
          render();
        } catch (e) {
          status.textContent = 'Could not read AccuLynx (' + (e && e.message ? e.message : e) + '). Open https://my.acculynx.com/calendar in another tab and try again, or use the search option below.';
        }
      };
      calSel.addEventListener('change', loadAppts);
      tasksBox.addEventListener('change', loadAppts);
      textBox.addEventListener('change', render);
      const go = (reply) => {
        const appt = (!textBox.checked && sel >= 0) ? appts[sel] : null;
        if (!appt && !textBox.checked) return;
        if (appt && !GUID.test(appt.ref)) { toast('That appointment has no job attached, so I cannot post to it. Use the search option instead.', '#e80'); return; }
        const fl = appt ? flagsOf(sel) : textFlags;
        if (launch(ctx, appt ? appt.ref : '', reply, fl)) closePicker();
      };
      bGot.addEventListener('click', () => go('Got it'));
      bCur.addEventListener('click', () => go('current'));

      (async () => {
        try {
          calendars = await getCalendars();
          if (!calendars.length) throw new Error('no calendars came back');
          calendars.sort((a, b) => a.name.localeCompare(b.name));
          const guess = calendarForOwner(ctx.owner, calendars) || calendarForOwner(ctx.rep, calendars);
          if (!guess) { const o = el('option', '', '- choose the rep -'); o.value = ''; calSel.appendChild(o); }
          calendars.forEach((c) => { const o = el('option', '', c.name); o.value = c.id; calSel.appendChild(o); });
          calSel.value = guess ? guess.id : '';
          await loadAppts();
        } catch (e) {
          status.textContent = 'Could not read AccuLynx (' + (e && e.message ? e.message : e) + '). Open https://my.acculynx.com/calendar in another tab and try again, or use the search option below.';
        }
      })();
    }

    function addButtons() {
      if (!isOn()) return;
      const owner = document.title.replace(/^GroupMe \|\s*/i, '').trim();
      if (!owner) return;
      allMsgs().forEach((msg) => {
        if (msg.querySelector('.amosDispoBtn')) return;           // already has one
        if (!isOwner(senderOf(msg), owner)) return;               // dispos come from the thread's owner
        const anchor = textBlock(msg);                            // text only, never photos
        if (!anchor) return;
        const btn = document.createElement('button');
        btn.className = 'amosDispoBtn';
        btn.textContent = 'Enter Dispo';
        Object.assign(btn.style, {
          display: 'block', margin: '4px 0 0 0', padding: '3px 10px', background: '#0a6cff', color: '#fff',
          border: 'none', borderRadius: '4px', cursor: 'pointer', font: '12px sans-serif'
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = dispoText(anchor);
          let time = postTime(msg);
          if (!time) time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          let rep = senderOf(msg).replace(/\s+\d+$/, '');              // "Duke Antonijevic 2" → "Duke Antonijevic"
          const cm = rep.match(/^([^,]+),\s*(.+)$/);                   // "Karandos,David" → "David Karandos"
          if (cm) rep = cm[2] + ' ' + cm[1];
          openPicker({ text, time, rep, owner, lead: parseLead(text), btn });
        });
        anchor.insertAdjacentElement('afterend', btn);
      });
    }
    setInterval(refresh, 1500);

    // When AccuLynx finishes: reopen THIS thread (if needed) and post "current"
    GM_addValueChangeListener(KEY_DONE, (_k, _old, done) => {
      if (!done || done.originTab !== TAB_ID) return;            // only the tab that clicked
      if (location.href !== done.threadUrl) {
        sessionStorage.setItem('amosSendCurrent', done.threadUrl);
        sessionStorage.setItem('amosSendReply', done.reply || 'current');
        if (done.note) sessionStorage.setItem('amosDispoNote', done.note);
        location.href = done.threadUrl;
        return;
      }
      if (done.note) toast(done.note, '#e80');
      sendCurrent(done.reply || 'current');
    });

    async function sendCurrent(word) {
      word = word || 'current';
      try { const n = sessionStorage.getItem('amosDispoNote'); if (n) { sessionStorage.removeItem('amosDispoNote'); toast(n, '#e80'); } } catch (e) {}
      GM_deleteValue(KEY_DONE);
      const box = await waitFor(() => document.querySelector('[role="textbox"]') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea'));
      if (!box) return toast('Could not find the GroupMe message box', '#c33');
      typeInto(box, word);
      await sleep(500);
      const send = [...document.querySelectorAll('button')].find((b) => visible(b) && !b.disabled && /^send message$/i.test(b.getAttribute('aria-label') || b.title || ''));
      if (send) send.click(); else pressEnter(box);
      await sleep(1200);
      if ((box.innerText || box.value || '').trim()) return toast('Typed "' + word + '" but it did not send — press Enter.', '#e80');
      toast('Dispo entered and "' + word + '" posted.');
      document.querySelectorAll('.amosDispoBtn').forEach((b) => { if (b.textContent === 'Entering...') { b.textContent = 'Done ✓'; } });
    }
    if (sessionStorage.getItem('amosSendCurrent') === location.href) {
      sessionStorage.removeItem('amosSendCurrent');
      const w = sessionStorage.getItem('amosSendReply') || 'current';
      sessionStorage.removeItem('amosSendReply');
      setTimeout(() => sendCurrent(w), 2500);
    }
  }

  // =====================================================================
  //  ACCULYNX SIDE
  // =====================================================================
  if (location.host === 'my.acculynx.com') {
    const SKEY = 'amosDispoTab';
    const JOB_RE = /\/jobs\/[0-9a-f-]{36}/i;
    let posting = false;                                     // blocks a second postComment while one is running

    // Backup route for the GroupMe picker: answer calendar requests from an AccuLynx tab that is already open
    GM_addValueChangeListener(KEY_REQ, async (_n, _o, req) => {
      if (!req || !req.id || Date.now() - (req.ts || 0) > 60000) return;
      try {
        const r = await fetch(req.path, {
          method: req.method || 'GET', credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: req.body ? JSON.stringify(req.body) : undefined
        });
        const text = await r.text();
        GM_setValue(KEY_RESP, { id: req.id, ok: r.ok, status: r.status, text: text.slice(0, 5000000) });
      } catch (e) { GM_setValue(KEY_RESP, { id: req.id, ok: false, error: String(e) }); }
    });

    (async function run() {
      const job = GM_getValue(KEY_JOB);
      if (!job || Date.now() - job.created > 15 * 60 * 1000) return;     // nothing pending
      // Only the tab that the Enter Dispo button opened may act (never your own AccuLynx tabs)
      if (location.href.includes('amosDispo=' + job.created)) sessionStorage.setItem(SKEY, String(job.created));
      if (sessionStorage.getItem(SKEY) !== String(job.created)) return;

      try {
        if (job.jobId) sessionStorage.setItem('amosDispoSearched', '1');     // picked from the calendar: no search needed
        if (!sessionStorage.getItem('amosDispoSearched')) return await doSearch(job);
        if (JOB_RE.test(location.pathname)) return await postComment(job);
        watchForJobPage(job);
      } catch (err) {
        status('stopped — ' + (err && err.message ? err.message : err), '#c33');
      }
    })();

    // Wait until the dropdown of search results stops changing
    async function waitStable(getItems, timeout) {
      const end = Date.now() + timeout;
      let last = -1, same = 0, items = [];
      while (Date.now() < end) {
        items = getItems();
        if (items.length && items.length === last) { if (++same >= 2) return items; } else same = 0;
        last = items.length;
        await sleep(500);
      }
      return items;
    }
    function pickMatches(items, job) {
      const jobs = items.filter((a) => /\/jobs\//.test(a.getAttribute('href') || ''));
      let hits = job.jobNum ? jobs.filter((a) => a.textContent.toUpperCase().includes(job.jobNum)) : [];
      if (!hits.length) {
        hits = jobs.filter((a) => { const t = norm(a.textContent); return job.tokens.length && job.tokens.every((k) => t.includes(k)); });
        if (job.addr) { const byAddr = hits.filter((a) => norm(a.textContent).includes(job.addr)); if (byAddr.length) hits = byAddr; }
        // Names can differ between GroupMe and AccuLynx — fall back to the street address alone
        if (!hits.length && job.addr) hits = jobs.filter((a) => norm(a.textContent).includes(job.addr));
      }
      // Same address twice (an old IN-job from a past sale AND the new lead)? The dispo says
      // "Job: N/A", i.e. no job number yet, so it belongs to the lead — the one without an IN number.
      if (hits.length > 1 && !job.jobNum) {
        const leads = hits.filter((a) => !/\bIN-\d+/i.test(a.textContent));
        if (leads.length === 1) hits = leads;
      }
      return hits;
    }

    async function doSearch(job) {
      const box = await waitFor(() => document.getElementById('js-site-search') || [...document.querySelectorAll('input[type="search"]')].find(visible));
      if (!box) return toast('Could not find the AccuLynx search box. Open the job yourself — the dispo will post when you do.', '#c33');
      sessionStorage.setItem('amosDispoSearched', '1');
      status('searching AccuLynx for ' + job.search + '...');
      await sleep(3000);                                  // the page is still starting up; typing too early is ignored
      let hits = [];
      const terms = [job.search, ...(job.alts || [])];
      for (let ti = 0; ti < terms.length && !hits.length; ti++) {
        const tries = ti === 0 ? 3 : 2;                    // the first term gets extra tries while the page warms up
        for (let attempt = 1; attempt <= tries && !hits.length; attempt++) {
          typeInto(box, '');
          await sleep(300);
          typeInto(box, terms[ti]);
          box.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
          const items = await waitStable(() => [...document.querySelectorAll('a.refinement-controls__search-result')].filter((a) => visible(a) && a.textContent.trim()), 8000);
          hits = pickMatches(items, job);
          if (!hits.length) status('no result for "' + terms[ti] + '" (try ' + attempt + '/' + tries + ')' + (ti + 1 < terms.length || attempt < tries ? ', trying again...' : ''), '#e80');
        }
      }
      if (hits.length === 1) { status('job found, opening it...'); hits[0].click(); }   // exactly one match: open it
      else toast(hits.length ? `${hits.length} jobs match — click the correct one and the dispo will post.` : 'No match found — open the correct job and the dispo will post.', '#e80');
      watchForJobPage(job);
    }

    function watchForJobPage(job) {
      const t = setInterval(() => {
        if (JOB_RE.test(location.pathname)) { clearInterval(t); postComment(job); }
      }, 700);
      setTimeout(() => clearInterval(t), 10 * 60 * 1000);
    }

    const fail = (msg) => toast(msg, '#c33');

    async function postComment(job) {
      if (posting) return;
      if (sessionStorage.getItem('amosDispoPosted') === String(job.created)) return;   // never post twice
      const id = location.pathname.match(JOB_RE)[0];
      if (!/\/comments/i.test(location.pathname)) { location.href = id + '/comments'; return; }  // Messages tab
      if (job.jobId && !location.pathname.toLowerCase().includes(job.jobId.toLowerCase())) return;   // on a different job: never post
      posting = true;
      try {
        await postCommentInner(job);
      } finally {
        posting = false;
      }
    }

    async function postCommentInner(job) {
      // Make sure this is the right job before posting anything
      // (A lead has no IN number in its title; then its own emails/comments must mention the number.)
      if (job.jobNum) {
        const verdict = await waitFor(() => {
          const t = document.title.toUpperCase();
          if (t.includes(job.jobNum)) return 'yes';
          if (/\bIN-\d+/.test(t)) return 'no';                        // it is a different numbered job
          return document.body.innerText.toUpperCase().includes(job.jobNum) ? 'yes' : null;
        }, 10000);
        const ok = verdict === 'yes';
        if (!ok) return fail(`This is not ${job.jobNum} — nothing was posted. Open ${job.jobNum} and the dispo will post.`);
      }
      status('on the job, preparing the comment...');
      const box = await waitFor(() => document.querySelector('textarea.form-v3-text__input') || [...document.querySelectorAll('textarea')].find(visible), 15000);
      if (!box) return fail('Could not find the AccuLynx comment box.');
      await sleep(2000);                                                     // let existing comments load

      // Already recorded on this job? Then do not record it again.
      const key = dupKey(job.text);
      if (key && norm(document.body.innerText).includes(norm(key))) {
        toast('This dispo is already on the job — not posting it again.', '#e80');
        return finish(job);
      }

      typeInto(box, job.comment);
      const post = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => visible(x) && x.innerText.trim() === 'Post');
        return b && !b.disabled ? b : null;
      }, 6000);
      if (!post) return fail('Comment typed but Post stayed disabled — click Post yourself.');
      sessionStorage.setItem('amosDispoPosted', String(job.created));
      post.click();
      const cleared = await waitFor(() => {
        const b = document.querySelector('textarea.form-v3-text__input');
        return !b || !b.value;
      }, 8000);
      if (!cleared) return fail('Clicked Post but the box did not clear — please check the job.');
      status('posted. Closing this tab...', '#2b7');
      finish(job);
    }

    // Insurance box: Damage Location "True" and/or Filed Claim + date, saved the same way the Insurance Updater saves
    async function applyInsurance(job) {
      const wantDam = job.dam || wantsDamage(job.text), wantClaim = job.claim || wantsClaim(job.text);
      if (!wantDam && !wantClaim) return '';
      const m = location.pathname.match(/\/jobs\/([0-9a-f-]{36})/i);
      const id = (job.jobId || (m && m[1]) || '').toLowerCase();
      if (!id) return 'Dispo posted, but the insurance box was not updated (no job id).';
      const call = async (path, opts) => {
        const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts, { headers: Object.assign({ Accept: 'application/json' }, opts && opts.body ? { 'Content-Type': 'application/json' } : {}) }));
        if (!r.ok) throw new Error('AccuLynx said ' + r.status);
        const t = await r.text(); return t ? JSON.parse(t) : null;
      };
      try {
        status('updating the insurance box...');
        const read = async () => (await call(`/api/jobOverview/${id}/GetLocationInformationWithInsurance`)).job.JobDetail;
        const d = await read();
        const blank = (v) => v === null || v === undefined || String(v).trim() === '';
        const ins = { InsuranceCompanyID: d.InsuranceCompanyID || null, DamageLocation: d.DamageLocation || '', DateOfLoss: d.DateOfLoss || null, ClaimField: !!d.ClaimField, ClaimFiledDate: d.ClaimFiledDate || null, ClaimNumber: d.ClaimNumber || '', HavePaperwork: !!d.HavePaperwork, InsuranceCompanyOtherName: d.InsuranceCompanyOtherName || '' };
        const did = []; const notes = [];
        if (wantDam) { if (blank(ins.DamageLocation)) { ins.DamageLocation = 'True'; did.push('Damage Location True'); } else if (String(ins.DamageLocation).toLowerCase() !== 'true') notes.push('Damage Location already says "' + ins.DamageLocation + '", left as is'); }
        if (wantClaim) {
          if (!ins.ClaimField) { ins.ClaimField = true; did.push('Filed Claim'); }
          if (blank(ins.ClaimFiledDate)) { const n = new Date(); ins.ClaimFiledDate = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}T00:00:00.000Z`; did.push('claim date ' + (n.getMonth() + 1) + '/' + n.getDate() + '/' + n.getFullYear()); }
        }
        if (did.length) {
          await call('/api/jobs/SaveInsuranceInfo', { method: 'POST', body: JSON.stringify({ JobDetail: ins, jobId: id }) });
          const back = await read();
          const bad = [];
          if (wantDam && String(back.DamageLocation || '').toLowerCase() !== String(ins.DamageLocation).toLowerCase()) bad.push('Damage Location');
          if (wantClaim && !back.ClaimField) bad.push('Filed Claim');
          if (wantClaim && blank(back.ClaimFiledDate)) bad.push('claim date');
          if (bad.length) return 'Dispo posted, but the insurance box did not save: ' + bad.join(', ') + '. Please check the job.';
        }
        return (did.length ? 'Insurance box updated: ' + did.join(', ') + '.' : 'Insurance box already filled in.') + (notes.length ? ' ' + notes.join(' ') : '');
      } catch (e) {
        return 'Dispo posted, but the insurance box was NOT updated (' + (e && e.message ? e.message : e) + '). Please do it by hand.';
      }
    }

    async function finish(job) {
      const note = await applyInsurance(job);
      sessionStorage.removeItem('amosDispoSearched');
      GM_deleteValue(KEY_JOB);
      GM_setValue(KEY_DONE, { threadUrl: job.threadUrl, originTab: job.originTab, reply: job.reply || 'current', note, at: Date.now() });
      setTimeout(() => window.close(), 1200);                                  // back to GroupMe
    }
  }
})();
