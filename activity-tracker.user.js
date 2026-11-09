// ==UserScript==
// @name         AccuLynx Activity Tracker
// @namespace    amos-activity-tracker
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/activity-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/activity-tracker.user.js
// @description  Records every Activity Feed event (comments, dead/cancelled, new leads, milestone changes, approvals) to a Google Sheet.
// @match        https://my.acculynx.com/dashboard*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ====== SETTINGS ======
  // The web app address and token are NOT stored in this file (it lives on a public GitHub page).
  // The first time the script runs it asks for them once and keeps them inside Tampermonkey.
  function savedSetting(key, question) {
    let v = '';
    try { v = GM_getValue(key, ''); } catch (e) { v = ''; }
    if (!v) {
      v = (window.prompt(question, '') || '').trim();
      if (v) GM_setValue(key, v);
    }
    return v;
  }
  const ENDPOINT = savedSetting('amosTrackerEndpoint', 'Activity Tracker: paste the Google Web App URL (it ends in /exec):');
  const TOKEN = savedSetting('amosTrackerToken', 'Activity Tracker: paste the token (it starts with amos-):');
  const SCAN_EVERY_MS = 60 * 1000;               // checks the feed once a minute
  // =================================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---- PARSER START (pure DOM reading; no network) ----
  function cyrb53(str, seed) {
    seed = seed || 0;
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Turns the feed's "4 min" / "2 hr" into an approximate age. tol = how far off the guess could be.
  // Anything a day old or older is marked skip (it is not today's activity and its time is too fuzzy).
  function relAge(text) {
    const s = clean(text).toLowerCase();
    let m;
    if (!s) return { ms: 0, p: 'unknown', tol: 0, skip: true };
    if (/few seconds|just now|^now/.test(s)) return { ms: 15e3, p: '~1 min', tol: 150e3 };
    if (/^(a|an) minute/.test(s)) return { ms: 60e3, p: '~1 min', tol: 150e3 };
    if ((m = s.match(/^(\d+)\s*min/))) return { ms: m[1] * 60e3, p: '~1 min', tol: 150e3 };
    if (/^(a|an) hour/.test(s)) return { ms: 3600e3, p: '~30 min', tol: 46 * 60e3 };
    if ((m = s.match(/^(\d+)\s*h/))) return { ms: m[1] * 3600e3, p: '~1 hr', tol: 36 * 60e3 };
    return { ms: 0, p: 'older than a day', tol: 0, skip: true };
  }

  // IMPORTANT: AccuLynx never refreshes the "4 min" / "a few seconds" labels on the page. A label that
  // says "a few seconds" can still be sitting there an hour later. So an event's time must be worked out
  // from when the label first appeared on screen, not from the current time.
  const stamps = new WeakMap();
  function anchorOf(el, label) {
    if (!el) return Date.now();
    const rec = stamps.get(el);
    if (rec && rec.label === label) return rec.t;
    const fresh = { label: label, t: Date.now() };
    stamps.set(el, fresh);
    return fresh.t;
  }
  function stampAll() {
    document.querySelectorAll('#activity-feed .activity-time-stamp, #activity-feed .message-time').forEach((el) => {
      anchorOf(el, clean(el.textContent));
    });
  }
  // Estimated real time of the label on one element.
  function labelTs(el) {
    const label = textOf(el);
    const age = relAge(label);
    return age.skip ? 0 : anchorOf(el, label) - age.ms;
  }

  function sentToOf(node) {
    const strong = Array.from(node.querySelectorAll('strong')).find((e) => /sent to/i.test(e.textContent));
    if (!strong || !strong.parentElement) return '';
    return clean(strong.parentElement.textContent.replace(/sent to:?/i, ''))
      .replace(/\s+,/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '');
  }

  function splitJob(text) {
    const t = clean(text);
    const m = t.match(/^([A-Z]{1,4}-\d+):\s*(.*)$/);
    return m ? { job: m[1], customer: m[2] } : { job: '', customer: t };
  }

  function textOf(el) { return el ? clean(el.textContent) : ''; }

  // Keeps line breaks so long comments read the way they were written.
  function richText(el) {
    if (!el) return '';
    const raw = typeof el.innerText === 'string' && el.innerText ? el.innerText : el.textContent;
    return (raw || '').replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
      .replace(/\s*Read (More|Less)\s*$/i, '').trim();
  }

  // Reads one <li> from the feed and returns its events (the item itself, plus any replies inside it).
  function parseItem(li, now) {
    const events = [];
    const rawType = textOf(li.querySelector('.activity-type'));
    const creator = textOf(li.querySelector('.activity-creator'));
    const jobInfo = splitJob(textOf(li.querySelector('.activity-job-info a')));
    const tsEl = li.querySelector('.activity-time-stamp');
    const tsLabel = textOf(tsEl);
    const age = relAge(tsLabel);
    const message = richText(li.querySelector('.activity-message'));
    const sentTo = sentToOf(li.querySelector('.right') || li);
    const base = { job: jobInfo.job, customer: jobInfo.customer, ts: anchorOf(tsEl, tsLabel) - age.ms, precision: age.p, tol: age.tol, skip: !!age.skip };
    const add = (o) => events.push(Object.assign({}, base, o));

    if (/^Comment by/i.test(rawType) || (!rawType && message)) {
      const dead = message.match(/^Job marked as Dead by (.+?)\.\s*Reason:\s*(.*)$/is);
      if (dead) add({ type: 'Job Marked Dead', person: clean(dead[1]) || creator, detail: 'Reason: ' + clean(dead[2]), sentTo: '' });
      else add({ type: 'Comment', person: creator, detail: message, sentTo: sentTo });
    } else if (/marked as Cancel/i.test(rawType)) {
      add({ type: 'Job Marked Cancelled', person: creator, detail: '', sentTo: '' });
    } else if (/^New Lead/i.test(rawType)) {
      const src = textOf(li.querySelector('.activity-leadsource'));
      const cat = textOf(li.querySelector('.activity-jobcategory'));
      add({ type: 'New Lead', person: creator, detail: [src, cat].filter(Boolean).join(' | '), sentTo: '' });
    } else if (/Approved/i.test(rawType)) {
      add({ type: 'Job Approved', person: creator, detail: message, sentTo: '' });
    } else if (/moved to|milestone|Lead moved/i.test(rawType)) {
      add({ type: 'Milestone Change', person: creator, detail: [rawType.replace(/:$/, ''), message].filter(Boolean).join(' - '), sentTo: '' });
    } else if (rawType) {
      add({ type: 'Other: ' + rawType.replace(/:$/, ''), person: creator, detail: message, sentTo: sentTo });
    }

    // Replies nested in the thread
    Array.from(li.querySelectorAll('.message-by')).forEach((byEl) => {
      let node = byEl;
      while (node && node !== li && (node.querySelectorAll('.message-by').length !== 1 || !node.querySelector('.message-time'))) {
        node = node.parentElement;
      }
      if (!node || node === li) return;
      const rEl = node.querySelector('.message-time');
      const rLabel = textOf(rEl);
      const rAge = relAge(rLabel);
      events.push({
        type: 'Reply', person: textOf(byEl), job: jobInfo.job, customer: jobInfo.customer,
        detail: richText(node.querySelector('.message-body')), sentTo: sentToOf(node),
        ts: anchorOf(rEl, rLabel) - rAge.ms, precision: rAge.p, tol: rAge.tol, skip: !!rAge.skip
      });
    });
    return events;
  }

  // Reads the whole feed. Each event gets a "hash" of what it says/who/where (not when).
  function collect() {
    const now = Date.now();
    const lis = Array.from(document.querySelectorAll('#activity-feed li.activity'));
    let all = [];
    lis.forEach((li) => { all = all.concat(parseItem(li, now)); });
    all.forEach((e) => { e.hash = cyrb53([e.type, e.person, e.job, e.customer, e.detail, e.sentTo].join('|')); });
    return all;
  }

  // The same event can show up in several feed rows (threads are re-listed when someone replies),
  // and its "2 hr" label drifts as time passes. Two sightings are the same event when their estimated
  // times overlap. 'known' = { hash: [[ts, tol], ...] }
  function sameEvent(list, ts, tol) {
    return (list || []).some((k) => Math.abs(k[0] - ts) <= k[1] + tol);
  }
  function pickNew(events, known) {
    const fresh = [];
    const pending = {};
    events.forEach((e) => {
      if (e.skip) return;
      if (sameEvent(known[e.hash], e.ts, e.tol) || sameEvent(pending[e.hash], e.ts, e.tol)) return;
      (pending[e.hash] = pending[e.hash] || []).push([e.ts, e.tol]);
      e.key = e.hash + '-' + Math.round(e.ts);
      fresh.push(e);
    });
    return fresh;
  }
  // ---- PARSER END ----

  // ---------- Feed helpers ----------
  function clickNewItems() {
    const el = Array.from(document.querySelectorAll('#activity-feed a, #activity-feed button, #activity-feed span, #activity-feed div'))
      .find((e) => e.children.length === 0 && /^View \d+ new items?$/i.test(clean(e.textContent)));
    if (el) { el.click(); return true; }
    return false;
  }

  async function expandAll() {
    let clicked = 0;
    document.querySelectorAll('#activity-feed .collapse-text-toggle').forEach((a) => {
      if (/^Read More$/i.test(clean(a.textContent))) { a.click(); clicked++; }
    });
    document.querySelectorAll('#activity-feed button').forEach((b) => {
      const m = clean(b.textContent).match(/^Show More Replies \((\d+)\)/i);
      if (m && Number(m[1]) > 0) { b.click(); clicked++; }
    });
    if (clicked) await sleep(1500);
  }

  // Scrolls the feed down to load older items (used once when the page opens).
  async function backfill() {
    const box = document.querySelector('#activity-feed .scroll-content') || document.querySelector('#activity-feed-body');
    if (!box) return;
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const stopBefore = d.getTime() - 3600e3;            // go back to about 11 PM last night
    let lastCount = 0, stalls = 0;
    for (let i = 0; i < 120; i++) {
      box.scrollTop = box.scrollHeight;
      await sleep(2000);
      stampAll();
      const lis = document.querySelectorAll('#activity-feed li.activity');
      // newest activity inside the last few rows (a thread keeps its old first comment, so look at its replies too)
      let newest = 0;
      Array.from(lis).slice(-6).forEach((li) => {
        li.querySelectorAll('.activity-time-stamp, .message-time').forEach((el) => { newest = Math.max(newest, labelTs(el)); });
      });
      if (newest && newest < stopBefore) break;
      if (lis.length === lastCount) { if (++stalls >= 4) break; } else { stalls = 0; lastCount = lis.length; }
    }
    box.scrollTop = 0;
  }

  // ---------- Remembering what was already sent ----------
  function loadKnown() {
    try { return JSON.parse(GM_getValue('knownEvents_v2', '{}')); } catch (e) { return {}; }
  }
  function saveKnown(known) {
    const cutoff = Date.now() - 3 * 864e5;
    Object.keys(known).forEach((h) => {
      known[h] = known[h].filter((k) => k[0] > cutoff);
      if (!known[h].length) delete known[h];
    });
    GM_setValue('knownEvents_v2', JSON.stringify(known));
  }

  function post(events) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: ENDPOINT,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify({ token: TOKEN, events: events }),
        onload: (r) => {
          try { const j = JSON.parse(r.responseText); j.ok ? resolve(j) : reject(new Error(j.error || 'rejected')); }
          catch (e) { reject(new Error('Bad reply - check the Web App URL and that access is set to Anyone')); }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timed out')), timeout: 60000
      });
    });
  }

  // ---------- Little status badge ----------
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#1f2937;color:#fff;font:12px/1.3 Arial,sans-serif;padding:6px 10px;border-radius:6px;cursor:pointer;opacity:.9;max-width:320px';
  badge.title = 'Activity Tracker - click to scan now';
  document.body.appendChild(badge);
  const setBadge = (t, bad) => { badge.textContent = t; badge.style.background = bad ? '#b91c1c' : '#1f2937'; };
  setBadge('Activity Tracker: starting...');

  let running = false;
  let totalSaved = 0;
  async function runScan() {
    if (running) return;
    running = true;
    try {
      if (!ENDPOINT || !TOKEN) { setBadge('Activity Tracker: reload the page and enter the Web App URL and token when asked', true); return; }
      stampAll();
      if (clickNewItems()) await sleep(1500);
      stampAll();
      await expandAll();
      stampAll();
      const known = loadKnown();
      const fresh = pickNew(collect(), known);
      for (let i = 0; i < fresh.length; i += 100) {
        const chunk = fresh.slice(i, i + 100);
        const res = await post(chunk.map((e) => ({
          key: e.key, hash: e.hash, ts: Math.round(e.ts), tol: e.tol, precision: e.precision, person: e.person,
          type: e.type, job: e.job, customer: e.customer, detail: e.detail, sentTo: e.sentTo
        })));
        chunk.forEach((e) => { (known[e.hash] = known[e.hash] || []).push([e.ts, e.tol]); });
        saveKnown(known);
        totalSaved += res.added || 0;
      }
      const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      setBadge('Activity Tracker OK ' + t + ' | new this scan: ' + fresh.length + ' | saved since page opened: ' + totalSaved);
    } catch (e) {
      setBadge('Activity Tracker problem: ' + e.message, true);
    } finally {
      running = false;
    }
  }
  badge.addEventListener('click', runScan);

  // Note the moment each time label first appears (see the IMPORTANT note above).
  let stampTimer = null;
  new MutationObserver(() => {
    if (stampTimer) return;
    stampTimer = setTimeout(() => { stampTimer = null; stampAll(); }, 150);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  (async function start() {
    await sleep(6000);                 // let the dashboard finish loading
    try { await backfill(); } catch (e) { /* ignore */ }
    await runScan();
    setInterval(runScan, SCAN_EVERY_MS);
  })();
})();
