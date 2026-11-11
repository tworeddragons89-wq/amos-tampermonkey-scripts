// ==UserScript==
// @name         Amos Dead Lead Reviver
// @namespace    amos-exteriors
// @version      1.2.1
// @description  Revives dead (Canceled) AccuLynx leads whose initial appointment (or created date) is 10+ years old, and moves the initial appointment to the first Wednesday of that same month and year.
// @match        https://my.acculynx.com/*
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/dead-lead-reviver.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/dead-lead-reviver.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== SETTINGS (edit here) ===================== */
  const VERSION = '1.2.1';
  const BATCH_SIZE = 1000;                  // the run pauses itself after this many revived leads so you can review
  const MIN_AGE_YEARS = 10;                 // "10 years old or older"
  const ASSIGN_REP_TO = 'Mars 3';           // every revived lead is reassigned to this company representative
  const DEFAULT_START_MIN = 6 * 60;         // used only when the lead had NO initial appointment: 6:00 AM
  const DEFAULT_END_MIN = 7 * 60;           //                                                      7:00 AM
  const LIST_URL = 'https://my.acculynx.com/jobs/?filters=currentMilestoneList:Dead';

  // Dead reasons that must NEVER be touched.
  const EXCLUDED_REASONS = [
    { name: 'Do Not Call',         re: /do\s*not\s*call|don'?t\s*call|\bdnc\b/i },
    { name: 'Duplicate',           re: /\bduplicate\b|\bdupe\b/i },
    { name: 'Wrong Number',        re: /wrong\s*number/i },
    { name: 'Out of Service Area', re: /out\s*of\s*(the\s*)?(our\s*)?(service\s*)?(area|territory)|outside\s*(of\s*)?(our\s*)?(service\s*)?area/i }
  ];
  /* ================================================================ */

  const KEY = 'amosDeadLeadReviver_v1';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Each browser tab gets its own id. Only the tab where you pressed Start runs the job; every other tab stays hands-off.
  let TAB = null;
  try { TAB = sessionStorage.getItem('dlrTab'); if (!TAB) { TAB = Math.random().toString(36).slice(2); sessionStorage.setItem('dlrTab', TAB); } } catch (e) { TAB = 'x' + Math.random(); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (a, b) => sleep(a + Math.random() * (b - a));

  /* ---------- state ---------- */
  function freshState() {
    return {
      running: false, phase: 'idle', current: null,
      processed: {},                       // id -> short outcome
      stats: { scanned: 0, revived: 0, skipped: 0, tooNew: 0, errors: 0 },
      log: [], maxRevive: BATCH_SIZE, runRevived: 0, pos: null
    };
  }
  let S;
  try { S = Object.assign(freshState(), JSON.parse(GM_getValue(KEY, '{}') || '{}')); } catch (e) { S = freshState(); }
  if (S.batchVer !== 2) { S.batchVer = 2; S.maxRevive = BATCH_SIZE; }
  const save = () => { if (S.running && S.owner && S.owner !== TAB) return; try { GM_setValue(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  function log(msg, level) {
    const line = { t: new Date().toISOString(), level: level || 'info', msg: String(msg) };
    S.log.push(line);
    if (S.log.length > 500) S.log = S.log.slice(-500);
    save(); renderPanel();
    console.log('[DeadLeadReviver]', msg);
  }
  function beep() {
    try { const c = new (window.AudioContext || window.webkitAudioContext)(); for (let i = 0; i < 3; i++) { const o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(c.currentTime + i * 0.4); o.stop(c.currentTime + i * 0.4 + 0.25); } } catch (e) { /* ignore */ }
    try { document.title = '\u2705 BATCH DONE - ' + document.title.replace(/^\u2705 BATCH DONE - /, ''); } catch (e) { /* ignore */ }
  }
  function stopRun(why) {
    S.running = false; S.stopAfter = false; S.owner = null; S.phase = 'idle'; S.current = null; save();
    log('STOPPED: ' + why, 'warn'); renderPanel();
  }

  /* ---------- helpers ---------- */
  async function waitFor(fn, timeout, interval) {
    const end = Date.now() + (timeout || 15000);
    while (Date.now() < end) {
      let v; try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(interval || 250);
    }
    return null;
  }
  const visible = e => e && e.offsetParent !== null;
  const bodyText = () => document.body.innerText || '';
  const jobIdFromPath = () => { const m = location.pathname.match(/^\/jobs\/([0-9a-f-]{36})/i); return m ? m[1] : null; };
  const isOverviewPath = () => /^\/jobs\/[0-9a-f-]{36}\/?$/i.test(location.pathname);
  const isSettingsPath = () => /^\/jobs\/[0-9a-f-]{36}\/settings/i.test(location.pathname);
  const isListPath = () => /^\/jobs\/?$/.test(location.pathname);

  function firstWednesday(y, m0) {
    const d = new Date(y, m0, 1);
    return 1 + ((3 - d.getDay() + 7) % 7);
  }
  function to24(h, ap) { h = parseInt(h, 10) % 12; return ap.toUpperCase() === 'PM' ? h + 12 : h; }

  // "November 13, 2026 4:00 PM - 6:00 PM"  or just "November 13, 2026"
  function parseAppt(txt) {
    txt = (txt || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt === '-' || txt === '--') return { has: false };
    let m = txt.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
    if (!m) return { has: true, bad: true, raw: txt };
    const mi = MONTHS.findIndex(x => x.toLowerCase().startsWith(m[1].slice(0, 3).toLowerCase()));
    if (mi < 0) return { has: true, bad: true, raw: txt };
    const r = { has: true, y: +m[3], m0: mi, d: +m[2], raw: txt };
    if (m[4]) {
      r.startMin = to24(m[4], m[6]) * 60 + +m[5];
      r.endMin = to24(m[7], m[9]) * 60 + +m[8];
    }
    return r;
  }
  function readOverview() {
    const dt = [...document.querySelectorAll('dt')].find(e => e.textContent.trim() === 'Initial Appt:');
    const apptTxt = dt && dt.nextElementSibling ? dt.nextElementSibling.textContent : '';
    const t = bodyText();
    const lm = t.match(/Lead\s*\n\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return {
      ready: !!dt && /Milestones/.test(t),
      dead: /Dead Milestone/.test(t) || /has been .Canceled./.test(t),
      appt: parseAppt(apptTxt),
      lead: lm ? { y: +lm[3], m0: +lm[1] - 1, d: +lm[2] } : null,
      name: ((document.querySelector('h1,h2,.job-name,[class*=job-header] [class*=name]') || {}).textContent || document.title || '').trim().slice(0, 60)
    };
  }
  const cutoffDate = () => { const n = new Date(); return new Date(n.getFullYear() - MIN_AGE_YEARS, n.getMonth(), n.getDate()); };

  function dueToReason(text) {
    // Structured comment AccuLynx writes: "Job marked as Dead by <name>. Reason: <reason>"
    const m = text.match(/Job marked as Dead by[^\n]*?Reason:\s*([^\n]+)/i);
    if (m) {
      const reason = m[1].trim();
      const hit = EXCLUDED_REASONS.find(r => r.re.test(reason));
      return { reason, excluded: hit ? hit.name : null, structured: true };
    }
    // Older leads only have free-text notes. Be conservative: any excluded phrase => leave alone.
    const hit = EXCLUDED_REASONS.find(r => r.re.test(text));
    return { reason: hit ? '(free text mentions "' + hit.name + '")' : '(no dead reason found)', excluded: hit ? hit.name : null, structured: false };
  }

  /* ---------- list page ---------- */
  async function doList() {
    if (!(await waitFor(() => document.querySelector('li.card a.card-name'), 25000))) {
      return stopRun('Could not find any leads on the Dead list.');
    }
    if (!/Canceled On/.test((document.querySelector('li.card') || {}).innerText || '')) {
      location.href = LIST_URL; return;
    }
    let stagnant = 0, lastCount = 0;
    while (S.running) {
      const cards = [...document.querySelectorAll('li.card a.card-name')];
      for (const a of cards) {
        const id = ((a.getAttribute('href') || '').match(/\/jobs\/([0-9a-f-]{36})/i) || [])[1];
        if (id && !S.processed[id]) {
          S.current = { id, name: a.textContent.trim(), info: null };
          S.phase = 'inspect'; save();
          log('Opening ' + S.current.name);
          await jitter(400, 900);
          location.href = '/jobs/' + id;
          return;
        }
      }
      // all visible cards done -> load more
      if (cards.length === lastCount) stagnant++; else stagnant = 0;
      lastCount = cards.length;
      if (stagnant >= 6) return stopRun('Reached the end of the Dead list. Nothing left to check.');
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
    }
  }

  /* ---------- inspect (decide) ---------- */
  async function doInspect() {
    const cur = S.current;
    if (!cur || jobIdFromPath() !== cur.id) { location.href = LIST_URL; return; }
    const ov = await waitFor(() => { const o = readOverview(); return o.ready ? o : null; }, 25000);
    if (!ov) return failLead('Overview never loaded', false);
    S.stats.scanned++;
    cur.name = ov.name || cur.name;

    if (!ov.dead) return finishLead('skip: not dead', 'skipped');
    if (ov.appt.bad) return finishLead('skip: could not read initial appt "' + ov.appt.raw + '"', 'skipped');

    const anchor = ov.appt.has ? ov.appt : ov.lead;
    const source = ov.appt.has ? 'initial appt' : 'created date';
    if (!anchor) return finishLead('skip: no initial appt and no created date found', 'skipped');
    const anchorDate = new Date(anchor.y, anchor.m0, anchor.d);
    if (anchorDate > cutoffDate()) {
      return finishLead('too new (' + source + ' ' + (anchor.m0 + 1) + '/' + anchor.d + '/' + anchor.y + ')', 'tooNew');
    }

    // ---- check the dead reason in the Messages tab ----
    const tab = [...document.querySelectorAll('a,li,span,div')].find(e => visible(e) && e.children.length <= 2 &&
      e.textContent.trim() === 'Messages' && e.getBoundingClientRect().top > 100 && e.getBoundingClientRect().top < 260);
    if (!tab) return failLead('Could not find the Messages tab', false);
    (tab.closest('a') || tab).click();
    await waitFor(() => /Filter Results|Latest Posts|Message Type|Create a new comment/.test(bodyText()), 15000);
    await sleep(2500);
    for (let i = 0; i < 6; i++) {          // expand older comments
      const more = [...document.querySelectorAll('a,button,span')].find(e => visible(e) && /Show More Comments/i.test(e.textContent) && e.children.length <= 1);
      if (!more) break;
      more.click(); await sleep(1500);
    }
    const why = dueToReason(bodyText());
    if (why.excluded) return finishLead('skip: dead reason "' + why.excluded + '" - ' + why.reason, 'skipped');

    const startMin = ov.appt.has && ov.appt.startMin != null ? ov.appt.startMin : DEFAULT_START_MIN;
    const endMin = ov.appt.has && ov.appt.endMin != null ? ov.appt.endMin : DEFAULT_END_MIN;
    const target = { y: anchor.y, m0: anchor.m0 };
    target.d = firstWednesday(target.y, target.m0);
    cur.info = { source, hadAppt: ov.appt.has, oldAppt: ov.appt.has ? ov.appt.raw : '', target, startMin, endMin, reason: why.reason };
    S.phase = 'reopen'; save();
    log('REVIVING ' + cur.name + ' | dead reason: ' + why.reason + ' | new appt ' + MONTHS[target.m0] + ' ' + target.d + ', ' + target.y);
    await jitter(500, 1000);
    location.href = '/jobs/' + cur.id + '/settings';
  }

  /* ---------- reopen ---------- */
  async function doReopen() {
    const cur = S.current;
    if (!cur || jobIdFromPath() !== cur.id) { location.href = LIST_URL; return; }
    const link = await waitFor(() => [...document.querySelectorAll('a.nav-link')].find(a => /Re-?\s?Open Job/i.test(a.textContent)), 20000);
    if (!link) return failLead('Re-Open Job link not found on Settings', false);
    link.click();
    const btn = await waitFor(() => document.querySelector('button[data-test="reopen-job__reopen"]'), 10000);
    if (!btn) return failLead('Re-Open Job button not found', false);
    await sleep(500);
    S.phase = 'appt'; save();
    btn.click();
    await sleep(4000);
    location.href = '/jobs/' + cur.id;
  }

  /* ---------- set the appointment ---------- */
  async function doAppt() {
    const cur = S.current;
    if (!cur || !cur.info || jobIdFromPath() !== cur.id) { location.href = LIST_URL; return; }
    const ov = await waitFor(() => { const o = readOverview(); return o.ready ? o : null; }, 25000);
    if (!ov) return failLead('Overview did not load after re-open', true);
    if (ov.dead) return failLead('Lead is STILL dead after clicking Re-Open Job', true);
    if (!cur.apptTries) { S.stats.revived++; S.runRevived++; }
    save();
    await sleep(cur.apptTries ? 3000 : 8000);   // let AccuLynx finish its own post-re-open work before we edit the appointment

    const T = cur.info.target;
    const label = MONTHS[T.m0] + ' ' + T.d + ', ' + T.y;
    try {
      // open the Location Info editor
      const sec = document.querySelector('#location-view') && document.querySelector('#location-view').closest('section.editable');
      const pencil = sec && sec.querySelector('span.edit');
      if (!pencil) throw new Error('Location Info edit pencil not found');
      pencil.click();
      const dsel = '.edit-location-modal__section--appointment-date-selector';
      const wrap = await waitFor(() => document.querySelector(dsel), 15000);
      if (!wrap) throw new Error('Edit Location panel did not open');
      await sleep(800);
      const dateInput = wrap.querySelector('input');

      // 1) delete the old initial appointment
      const clear = wrap.querySelector('button.form-v3-select__clear');
      if (dateInput.value && clear) { clear.click(); await sleep(700); }
      if (dateInput.value) throw new Error('Could not clear the old appointment date');

      // 2) pick the new date in the calendar (walk month by month)
      // NOTE: the calendar does not have to be open - its day buttons still work while hidden,
      // which is more reliable than trying to pop it open (that fails if the window is not focused).
      const cals = [...document.querySelectorAll('.flatpickr-calendar')];
      if (!cals.length) throw new Error('Calendar not found on page');
      for (const cal of cals) {
        if (dateInput.value && dateInput.value.indexOf(String(T.y)) >= 0) break;
        const yrEl = cal.querySelector('.cur-year'), moEl = cal.querySelector('select.flatpickr-monthDropdown-months');
        if (!yrEl || !moEl) continue;
        const diff = (parseInt(yrEl.value, 10) * 12 + parseInt(moEl.value, 10)) - (T.y * 12 + T.m0);
        const nav = cal.querySelector(diff > 0 ? '.flatpickr-prev-month' : '.flatpickr-next-month');
        for (let i = 0; i < Math.abs(diff); i++) nav.click();
        await sleep(400);
        const dayEl = [...cal.querySelectorAll('.flatpickr-day')].find(x => x.getAttribute('aria-label') === label);
        if (!dayEl) continue;
        ['mousedown', 'mouseup', 'click'].forEach(t => dayEl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
        await sleep(800);
      }
      if (!dateInput.value || dateInput.value.indexOf(String(T.y)) < 0) throw new Error('Date did not take (field shows "' + dateInput.value + '")');

      // 3) times
      const sels = await waitFor(() => { const s = [...document.querySelectorAll('.appointment-times-selector select')]; return s.length === 2 && !s[0].disabled ? s : null; }, 8000);
      if (!sels) throw new Error('Start/End time boxes did not unlock');
      const setSel = (sel, min) => {
        const opt = [...sel.options].find(o => o.value === String(min));
        if (!opt) throw new Error('Time option ' + min + ' not available');
        sel.value = String(min);
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setSel(sels[0], cur.info.startMin); await sleep(400);
      setSel(sels[1], cur.info.endMin); await sleep(400);
      if (sels[0].value !== String(cur.info.startMin) || sels[1].value !== String(cur.info.endMin)) throw new Error('Times did not stick');

      // 4) save
      const saveBtn = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Save');
      if (!saveBtn) throw new Error('Save button not found');
      S.phase = 'verify'; save();
      saveBtn.click();
      await waitFor(() => !document.querySelector(dsel), 15000);
      await sleep(5000);            // changing an EXISTING appointment can take a few seconds to commit
      location.reload();
    } catch (err) {
      const cancel = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Cancel' && /text-blue/.test(b.className));
      if (cancel) cancel.click();
      failLead('REVIVED but appointment NOT set: ' + err.message + ' (fix this lead by hand)', true);
    }
  }

  /* ---------- reassign the lead to Mars 3 ---------- */
  async function assignRep(repName, dryRun) {
    const repLabel = () => { const e = document.querySelector('.job-rep-wrapper .rep-name'); return e ? e.textContent.trim() : ''; };
    if (repLabel() === repName) return 'already';
    const wrap = document.querySelector('.job-rep-wrapper');
    const toggle = wrap && wrap.querySelector('button.no-focus-outline');
    if (!toggle) throw new Error('assigned-rep box not found');
    toggle.click();
    const box = await waitFor(() => document.querySelector('.primary-rep-details'), 6000);
    if (!box) throw new Error('rep details did not open');
    let top = box, pencil = null;
    for (let i = 0; i < 5 && top && !pencil; i++) { pencil = top.querySelector('span.edit'); top = top.parentElement; }
    if (!pencil) throw new Error('rep edit pencil not found');
    pencil.click();
    const sel = await waitFor(() => {
      const lab = [...document.querySelectorAll('label')].find(l => /Company Representative/.test(l.textContent));
      let c = lab; for (let i = 0; i < 4 && c && !c.querySelector('select'); i++) c = c.parentElement;
      return c && c.querySelector('select');
    }, 10000);
    if (!sel) throw new Error('Company Representative box did not open');
    const opt = [...sel.options].find(o => o.text.trim() === repName);
    if (!opt) throw new Error('"' + repName + '" not in the representative list');
    if (dryRun) {
      const cancel = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Cancel');
      if (cancel) cancel.click();
      return 'dry-run ok';
    }
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(600);
    const saveBtn = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Save');
    if (!saveBtn) throw new Error('Save button not found for representative');
    saveBtn.click();
    if (!(await waitFor(() => repLabel() === repName, 12000))) throw new Error('rep still shows "' + repLabel() + '" after save');
    return 'changed';
  }

  /* ---------- verify ---------- */
  async function doVerify() {
    const cur = S.current;
    if (!cur || !cur.info || jobIdFromPath() !== cur.id) { location.href = LIST_URL; return; }
    const ov = await waitFor(() => { const o = readOverview(); return o.ready ? o : null; }, 25000);
    const T = cur.info.target;
    const label = MONTHS[T.m0] + ' ' + T.d + ', ' + T.y;
    if (ov && ov.appt.has && !ov.appt.bad && ov.appt.y === T.y && ov.appt.m0 === T.m0 && ov.appt.d === T.d) {
      let repResult;
      try { repResult = await assignRep(ASSIGN_REP_TO); }
      catch (e) { return failLead('REVIVED + appointment OK, but could not reassign to ' + ASSIGN_REP_TO + ': ' + e.message + ' (fix this lead by hand)', true); }
      log('DONE ' + cur.name + ': initial appt now ' + ov.appt.raw + (cur.info.oldAppt ? ' (was ' + cur.info.oldAppt + ')' : ' (had none)') + ' | rep -> ' + ASSIGN_REP_TO + ' (' + repResult + ')', 'ok');
      return finishLead('revived -> ' + label + ', rep ' + ASSIGN_REP_TO, 'ok');
    }
    // Not showing yet - AccuLynx may still be saving. Wait and reload a few times before giving up.
    cur.verifyTries = (cur.verifyTries || 0) + 1; save();
    if (cur.verifyTries === 2 && (cur.apptTries || 0) < 2) {
      cur.apptTries = (cur.apptTries || 0) + 1; cur.verifyTries = 0; S.phase = 'appt'; save();
      log('Appointment did not stick - redoing the appointment edit (attempt ' + (cur.apptTries + 1) + ')', 'warn');
      location.reload();
      return;
    }
    if (cur.verifyTries <= 4) {
      log('Appointment not showing yet (try ' + cur.verifyTries + '/4), waiting...', 'warn');
      await sleep(6000);
      location.reload();
      return;
    }
    return failLead('REVIVED but the saved appointment does not read ' + label + ' (page shows "' + (ov ? ov.appt.raw || 'blank' : 'n/a') + '")', true);
  }

  /* ---------- bookkeeping ---------- */
  async function finishLead(outcome, kind) {
    const cur = S.current;
    if (cur) S.processed[cur.id] = outcome;
    if (kind === 'skipped') S.stats.skipped++;
    if (kind === 'tooNew') S.stats.tooNew++;
    if (kind !== 'ok') log((cur ? cur.name : '?') + ': ' + outcome);
    S.current = null; S.phase = 'list'; save();
    if (S.stopAfter) return stopRun('Stopped after finishing the lead in progress.');
    if (S.runRevived >= S.maxRevive) { beep(); return stopRun('BATCH COMPLETE: revived ' + S.runRevived + ' lead(s) this run. Totals - checked ' + S.stats.scanned + ', revived ' + S.stats.revived + ', skipped ' + S.stats.skipped + ', too new ' + S.stats.tooNew + ', errors ' + S.stats.errors + '. Download the log, tell Claude, then press Start for the next ' + BATCH_SIZE + '.'); }
    await jitter(500, 1100);
    location.href = LIST_URL;
  }
  function failLead(msg, revivedAlready) {
    const cur = S.current;
    S.stats.errors++;
    if (cur) S.processed[cur.id] = 'ERROR: ' + msg;
    log((cur ? cur.name + ' (' + cur.id + ')' : '?') + ': ' + msg, 'error');
    stopRun('Error - check the log, fix this lead by hand if needed, then press Start to continue.');
    return null;
  }

  /* ---------- router ---------- */
  async function tick() {
    if (!S.running || (S.owner && S.owner !== TAB)) return;
    await sleep(1500);
    if (!S.running || (S.owner && S.owner !== TAB)) return;
    try {
      if (S.phase === 'list' || S.phase === 'idle') {
        if (isListPath()) return doList();
        location.href = LIST_URL; return;
      }
      if (S.phase === 'inspect') return isOverviewPath() ? doInspect() : (location.href = S.current ? '/jobs/' + S.current.id : LIST_URL);
      if (S.phase === 'reopen')  return isSettingsPath() ? doReopen() : (location.href = '/jobs/' + S.current.id + '/settings');
      if (S.phase === 'appt')    return isOverviewPath() ? doAppt() : (location.href = '/jobs/' + S.current.id);
      if (S.phase === 'verify')  return isOverviewPath() ? doVerify() : (location.href = '/jobs/' + S.current.id);
    } catch (e) {
      failLead('Unexpected error: ' + e.message, true);
    }
  }

  /* ---------- panel ---------- */
  let panel;
  function el(tag, css, html) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  function buildPanel() {
    panel = el('div', 'position:fixed;z-index:2147483000;width:320px;background:#fff;border:1px solid #1f3b63;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.3);font:12px/1.35 Arial,sans-serif;color:#222;');
    const pos = S.pos || { top: 90, left: Math.max(10, window.innerWidth - 350) };
    panel.style.top = pos.top + 'px'; panel.style.left = pos.left + 'px';
    document.body.appendChild(panel);
    renderPanel();
  }
  function renderPanel() {
    if (!panel) return;
    const st = S.stats;
    panel.innerHTML = '';
    const head = el('div', 'background:#1f3b63;color:#fff;padding:6px 8px;cursor:move;border-radius:7px 7px 0 0;font-weight:bold;display:flex;justify-content:space-between;', 'Dead Lead Reviver v' + VERSION + '<span>' + (S.running ? (S.owner && S.owner !== TAB ? '&#9679; running in another tab' : '&#9679; RUNNING') : '&#9632; stopped') + '</span>');
    panel.appendChild(head);
    head.onmousedown = e => {
      const dx = e.clientX - panel.offsetLeft, dy = e.clientY - panel.offsetTop;
      const mv = ev => { panel.style.left = (ev.clientX - dx) + 'px'; panel.style.top = (ev.clientY - dy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); S.pos = { top: panel.offsetTop, left: panel.offsetLeft }; save(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault();
    };
    const body = el('div', 'padding:8px;');
    body.appendChild(el('div', '', 'Checked: <b>' + st.scanned + '</b> &nbsp; Revived: <b style="color:#0a7a2f">' + st.revived + '</b> &nbsp; Skipped: <b>' + st.skipped + '</b> &nbsp; Too new: <b>' + st.tooNew + '</b> &nbsp; Errors: <b style="color:#b00020">' + st.errors + '</b>'));
    body.appendChild(el('div', 'margin:4px 0;color:#555;', S.current ? 'Working on: ' + S.current.name + ' (' + S.phase + ')' : 'Idle'));
    const row = el('div', 'margin:6px 0;display:flex;align-items:center;gap:6px;', 'Stop after reviving <input id="dlr-max" type="number" min="1" style="width:60px;" value="' + S.maxRevive + '"> leads');
    body.appendChild(row);
    const btns = el('div', 'display:flex;gap:6px;margin:6px 0;');
    const mk = (txt, bg, fn) => { const b = el('button', 'flex:1;padding:6px;border:0;border-radius:4px;color:#fff;cursor:pointer;background:' + bg, txt); b.onclick = fn; return b; };
    btns.appendChild(mk('Start', '#0a7a2f', () => {
      const v = parseInt(document.getElementById('dlr-max').value, 10);
      S.maxRevive = v > 0 ? v : BATCH_SIZE; S.runRevived = 0; S.running = true; S.owner = TAB; S.phase = 'list'; S.current = null; save(); log('Started. Will stop after ' + S.maxRevive + ' revived lead(s).');
      if (isListPath()) tick(); else location.href = LIST_URL;
    }));
    btns.appendChild(mk('Stop', '#b00020', () => {
      if (S.running && S.current && ['reopen', 'appt', 'verify'].indexOf(S.phase) >= 0) { S.stopAfter = true; save(); log('Stop requested - finishing the lead in progress first so it is not left half-done...', 'warn'); }
      else stopRun('You pressed Stop.');
    }));
    body.appendChild(btns);
    const btns2 = el('div', 'display:flex;gap:6px;margin:4px 0;');
    btns2.appendChild(mk('Download log', '#555', downloadLog));
    btns2.appendChild(mk('Reset memory', '#888', () => { if (confirm('Forget which leads were already checked? (Does not change AccuLynx.)')) { S = Object.assign(freshState(), { pos: S.pos }); save(); renderPanel(); } }));
    body.appendChild(btns2);
    const lg = el('div', 'height:120px;overflow:auto;background:#f4f6f8;border:1px solid #ddd;padding:4px;margin-top:4px;font-size:11px;');
    lg.innerHTML = S.log.slice(-40).reverse().map(l => '<div style="color:' + (l.level === 'error' ? '#b00020' : l.level === 'ok' ? '#0a7a2f' : l.level === 'warn' ? '#9a6700' : '#222') + '">' + l.t.slice(11, 19) + ' ' + l.msg.replace(/</g, '&lt;') + '</div>').join('');
    body.appendChild(lg);
    panel.appendChild(body);
  }
  function downloadLog() {
    const rows = ['time,level,message'].concat(S.log.map(l => [l.t, l.level, '"' + l.msg.replace(/"/g, '""') + '"'].join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    a.download = 'dead-lead-reviver-log.csv'; a.click();
  }

  buildPanel();
  tick();
})();
